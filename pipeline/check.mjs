#!/usr/bin/env node
/**
 * Auto-teste offline: valida configs, filtros, score, dedup e cotas sem tocar na rede.
 * Roda no CI antes de qualquer coleta. Se este arquivo passa, a logica de triagem esta sa.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toCanonicalJob, dedupe, detectWorkModel, parseSalaryFromText, monthlyBrl, cityPart } from "./lib/normalize.mjs";
import { scoreJob, applyQuotas } from "./lib/score.mjs";
import { extractJson, estimateCost } from "./lib/ai.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (rel) => JSON.parse(await fs.readFile(path.join(ROOT, rel), "utf8"));

let passed = 0;
const failures = [];
function check(label, condition, detail = "") {
  if (condition) { passed += 1; console.log(`  ok    ${label}`); }
  else { failures.push(`${label}${detail ? ` -> ${detail}` : ""}`); console.log(`  FALHA ${label} ${detail}`); }
}

const searchConfig = await readJson("config/search-profiles.json");
const sourcesConfig = await readJson("config/sources.json");
const profileCv = await readJson("config/profile.json");
const profile = searchConfig.profiles.find((p) => p.id === searchConfig.active_profile);
const aiSrcEager = await fs.readFile(path.join(ROOT, "pipeline/lib/ai.mjs"), "utf8");
const fx = searchConfig.fx_to_brl;
// Copia do perfil com o balde internacional ligado: ele esta desligado por opcao
// do Carlos, mas a logica precisa continuar correta caso ele volte a liga-lo.
const profileIntl = JSON.parse(JSON.stringify(profile));
profileIntl.locations.find((l) => l.id === "remote_intl").enabled = true;

console.log("\n1. Configuracao");
check("perfil ativo existe", Boolean(profile), searchConfig.active_profile);
check("soma das cotas nao passa de 1", (profile.locations || []).filter((l) => l.enabled !== false).reduce((s, l) => s + (l.quota || 0), 0) <= 1.001);
check("prioridade geografica SJRP > remoto internacional > Sao Paulo", (() => {
  const w = Object.fromEntries(profile.locations.map((l) => [l.id, l.weight]));
  return w.sjrp > w.remote_intl && w.remote_intl > w.sao_paulo;
})());
for (const source of sourcesConfig.sources) {
  try { await import(`./sources/${source.module}`); } catch (e) { failures.push(`modulo ${source.module}: ${e.message}`); }
}
check("todos os modulos de fonte carregam", failures.length === 0);
check("perfil de CV tem experiencias", (profileCv.experience || []).length > 0);
check("perfil tem contato completo", Boolean(profileCv.identity?.phone && profileCv.identity?.linkedin && !String(profileCv.identity.linkedin).includes("PREENCHER")));
check("perfil tem cabecalho de localidade por regiao", Boolean(profileCv.identity?.location_strategy?.sjrp && profileCv.identity?.location_strategy?.sao_paulo));
check("todas as experiencias tem periodo preenchido", (profileCv.experience || []).every((e) => e.start && !String(e.start).includes("PREENCHER")));
check("convencao de anonimizar clientes esta declarada", profileCv.conventions?.anonymize_clients === true);
check("gerador respeita a anonimizacao e o cabecalho", (() => {
  const src = aiSrcEager;
  return src.includes("NAO nomeie clientes") && src.includes("location_strategy");
})());

console.log("\n2. Normalizacao");
check("detecta remoto", detectWorkModel({ title: "Operations Manager", location_raw: "Remote - Anywhere", description: "" }) === "remote");
check("detecta hibrido", detectWorkModel({ title: "Coordenador", location_raw: "Sao Paulo - Hibrido", description: "" }) === "hybrid");
check("le salario de texto", (() => {
  const s = parseSalaryFromText("Salario de R$ 17.500,00 mensais mais beneficios");
  return s && s.min === 17500 && s.currency === "BRL";
})());
check("converte USD anual para BRL mensal", monthlyBrl({ min: 90000, currency: "USD", period: "yearly" }, fx) === Math.round(90000 * 5.4 / 12));
check("ignora numero sem contexto de salario", parseSalaryFromText("Atendemos 25.000 clientes por mes") === null);

console.log("\n3. Filtros duros");
const make = (over) => toCanonicalJob({
  title: "Coordenador de Operacoes", company: "Empresa X", location_raw: "Sao Jose do Rio Preto, SP",
  description: "Gestao de processos, indicadores e melhoria continua com Power BI e SQL. Setor de alimentos.",
  url: `https://exemplo.com/${Math.random()}`, posted_at: new Date(Date.now() - 3 * 86400000).toISOString(), ...over
}, "teste");

check("bloqueia cidade fora dos criterios", scoreJob(make({ location_raw: "Ribeirao Preto, SP" }), profile, { fx }).block_reason === "LOCALIZACAO_FORA_DOS_CRITERIOS");
check("bloqueia vaga junior", scoreJob(make({ title: "Analista Junior de Operacoes" }), profile, { fx }).block_reason?.startsWith("SENIORIDADE_EXCLUIDA"));
check("bloqueia vaga comercial pelo titulo", scoreJob(make({ title: "Executivo de Vendas" }), profile, { fx }).block_reason?.startsWith("FOCO_COMERCIAL_NO_TITULO"));
check("bloqueia vaga comercial pela descricao sem contexto de operacoes", scoreJob(make({ title: "Consultor de Negocios", description: "Rotina de prospeccao ativa e cold call para formar carteira de clientes propria." }), profile, { fx }).block_reason?.startsWith("FOCO_COMERCIAL_NA_DESCRICAO"));
check("bloqueia vaga antiga", scoreJob(make({ posted_at: new Date(Date.now() - 90 * 86400000).toISOString() }), profile, { fx }).block_reason?.startsWith("VAGA_ANTIGA"));
check("bloqueia salario abaixo do piso", scoreJob(make({ description: "Salario de R$ 6.000,00 mensais" }), profile, { fx }).block_reason?.startsWith("SALARIO_ABAIXO_DO_PISO"));
check("NAO bloqueia vaga de operacoes que apenas menciona vendas", scoreJob(make({ description: "Coordenar operacoes, processos e indicadores da area, com interface com vendas e governanca de planejamento." }), profile, { fx }).blocked === false);
check("remoto internacional fica fora enquanto o balde esta desligado", scoreJob(make({ title: "Operations Manager", location_raw: "Remote - Europe", company: "Acme Inc", description: "Remote role. Process improvement, KPIs." }), profile, { fx }).blocked === true);
check("...mas volta a funcionar se o balde for religado", (() => {
  const r = scoreJob(make({ title: "Operations Manager", location_raw: "Remote - Europe", company: "Acme Inc", description: "Remote role. Process improvement, KPIs, SQL and Power BI. English required." }), profileIntl, { fx });
  return r.blocked === false && r.location_bucket === "remote_intl";
})());
check("remoto brasileiro fica fora enquanto o bucket esta desligado", scoreJob(make({ title: "Gerente de Operacoes", location_raw: "Remoto - Brasil", description: "Trabalho remoto em todo o Brasil, processos e indicadores." }), profile, { fx }).blocked === true);

console.log("\n3b. Ruido real visto no primeiro diagnostico");
check("bloqueia 'Assistant Housekeeping Manager' (RemoteOK)", (() => {
  const r = scoreJob(make({ title: "Assistant Housekeeping Manager", company: "Marriott International", location_raw: "Remote - Goa", description: "Housekeeping operations for the property." }), profile, { fx });
  return r.blocked === true;
})(), JSON.stringify(scoreJob(make({ title: "Assistant Housekeeping Manager", company: "Marriott International", location_raw: "Remote - Goa", description: "Housekeeping operations." }), profile, { fx }).block_reason));
check("bloqueia 'Consultor(A) De Vendas' apesar do (A) no meio (Jooble)", (() => {
  const r = scoreJob(make({ title: "Consultor(A) De Vendas - Expansao De Negocios", location_raw: "Sao Jose do Rio Preto, SP" }), profile, { fx });
  return r.block_reason?.startsWith("FOCO_COMERCIAL_NO_TITULO");
})());
check("bloqueia 'Franchise Business Consultant' (Adzuna internacional)", (() => {
  const r = scoreJob(make({ title: "Franchise Business Consultant-Senior Care", company: "Amada franchise inc", location_raw: "Remote - USA", description: "Support franchisees." }), profile, { fx });
  return r.blocked === true;
})());
check("vaga presencial com 'remote' solto na descricao nao vira remoto internacional", (() => {
  const job = toCanonicalJob({
    title: "Business Consultant", company: "Amada", location_raw: "Phoenix, Maricopa County",
    description: "We offer remote support to our franchise network in the region.",
    url: "https://ex.com/z", posted_at: new Date().toISOString()
  }, "adzuna_us");
  return job.work_model !== "remote" && scoreJob(job, profile, { fx }).blocked === true;
})());
check("vaga remota internacional legitima entra quando o balde esta ligado", (() => {
  const job = toCanonicalJob({
    title: "Operations Manager", company: "Acme Global", location_raw: "Remote - Worldwide",
    description: "Process improvement, KPIs, SQL and Power BI. English required.",
    url: "https://ex.com/y", posted_at: new Date().toISOString()
  }, "remotive");
  const r = scoreJob(job, profileIntl, { fx });
  return r.blocked === false && r.location_bucket === "remote_intl";
})());

console.log("\n3c. Cargos e resgates da nova estrategia de busca");
check("PMO esta entre os cargos buscados", (profile.queries || []).some((q) => /\bpmo\b/i.test(q)), (profile.queries || []).length + " cargos");
check("cargos do exterior sao de consultoria", (() => {
  const intl = profile.queries_international || [];
  const consult = intl.filter((q) => /consultant|consulting/i.test(q)).length;
  return intl.length >= 8 && consult / intl.length >= 0.6;
})(), (profile.queries_international || []).join(" | "));
check("Mirassol entra no balde de Rio Preto", (() => {
  const r = scoreJob(make({ title: "Gerente Administrativo", location_raw: "Mirassol, SP" }), profile, { fx });
  return r.blocked === false && r.location_bucket === "sjrp";
})());
check("Ribeirao Preto continua fora", scoreJob(make({ title: "Gerente Administrativo", location_raw: "Ribeirao Preto, SP" }), profile, { fx }).blocked === true);
check("'Coordenador de Planejamento de Vendas (S&OP)' NAO e bloqueado", (() => {
  const r = scoreJob(make({ title: "Coordenador de Planejamento de Vendas S&OP", location_raw: "Sao Jose do Rio Preto, SP", description: "Planejamento de demanda, S&OP, processos e indicadores com a operacao." }), profile, { fx });
  return r.blocked === false && r.flags.some((f) => f.includes("confirmar se o foco"));
})(), JSON.stringify(scoreJob(make({ title: "Coordenador de Planejamento de Vendas S&OP", location_raw: "Sao Jose do Rio Preto, SP" }), profile, { fx }).block_reason));
check("'Executivo de Vendas' continua bloqueado (nao tem termo de operacao)", scoreJob(make({ title: "Executivo de Vendas" }), profile, { fx }).block_reason?.startsWith("FOCO_COMERCIAL_NO_TITULO"));
check("'Gerente Administrativo' em hospital pontua bem", (() => {
  const r = scoreJob(make({ title: "Gerente Administrativo", company: "Hospital de Base", location_raw: "Sao Jose do Rio Preto, SP", description: "Gestao administrativa, processos, indicadores e projetos da operacao hospitalar. Power BI." }), profile, { fx });
  return r.blocked === false && r.score >= 70;
})(), String(scoreJob(make({ title: "Gerente Administrativo", company: "Hospital de Base", location_raw: "Sao Jose do Rio Preto, SP", description: "Gestao administrativa, processos, indicadores e projetos da operacao hospitalar. Power BI." }), profile, { fx }).score));
check("saude e industria prioritaria", (profile.industries.priority || []).includes("saude"));
check("cargo do exterior pontua pelo titulo igual aos do Brasil", (() => {
  const job = toCanonicalJob({
    title: "Management Consultant", company: "Globant", location_raw: "Remote - LATAM",
    description: "Fully remote across LATAM. Business transformation, process improvement, stakeholder management, KPIs. English required.",
    url: "https://ex.com/mc", posted_at: new Date().toISOString()
  }, "remotive");
  const r = scoreJob(job, profileIntl, { fx });
  return r.blocked === false && r.components.role === profile.weights.role;
})());
check("prompt da IA leva autorizacao de trabalho", (await fs.readFile(path.join(ROOT, "pipeline/lib/ai.mjs"), "utf8")).includes("work_authorization: profile.identity?.work_authorization"));

console.log("\n3d. Cidade vs estado (o bug que trouxe Barueri e Ribeirao Preto)");
check("cityPart descarta o estado", cityPart("Barueri, Sao Paulo") === "barueri" && cityPart("Sao Paulo, Sao Paulo") === "sao paulo");
check("cityPart aceita endereco de um segmento so", cityPart("Sao Paulo") === "sao paulo");
check("cityPart lida com bairro + cidade + estado", cityPart("Vila Olimpia, Sao Paulo, Sao Paulo").includes("sao paulo"));
check("Barueri NAO entra no balde de Sao Paulo", scoreJob(make({ title: "Gerente de Operacoes", location_raw: "Barueri, Sao Paulo" }), profile, { fx }).block_reason === "LOCALIZACAO_FORA_DOS_CRITERIOS");
check("Ribeirao Preto NAO entra no balde de Sao Paulo", scoreJob(make({ title: "Gerente de Operacoes", location_raw: "Ribeirao Preto, Sao Paulo" }), profile, { fx }).block_reason === "LOCALIZACAO_FORA_DOS_CRITERIOS");
check("a capital continua entrando", scoreJob(make({ title: "Gerente de Operacoes", location_raw: "Sao Paulo, Sao Paulo" }), profile, { fx }).location_bucket === "sao_paulo");
check("Rio Preto com estado por extenso entra", scoreJob(make({ title: "Gerente de Operacoes", location_raw: "Sao Jose do Rio Preto, Estado de Sao Paulo" }), profile, { fx }).location_bucket === "sjrp");

console.log("\n3e. Prioridade de Rio Preto");
check("Rio Preto entra com nota mais baixa que Sao Paulo", (profile.locations.find((l) => l.id === "sjrp").min_score) < (profile.locations.find((l) => l.id === "sao_paulo").min_score));
check("Sao Paulo tem teto de participacao no feed", profile.locations.find((l) => l.id === "sao_paulo").max_share <= 0.25);
check("balde internacional esta desligado", profile.locations.find((l) => l.id === "remote_intl").enabled === false);
check("Sao Paulo nao passa do teto mesmo com Rio Preto vazio", (() => {
  const pool = Array.from({ length: 60 }, (_, i) => ({ company: `Empresa SP ${i}`, score: { final: 95 - (i % 20), location_bucket: "sao_paulo" } }));
  const r = applyQuotas(pool, profile);
  const teto = Math.round(profile.filters.feed_size * profile.locations.find((l) => l.id === "sao_paulo").max_share);
  return (r.mix.sao_paulo || 0) <= teto;
})(), JSON.stringify(applyQuotas(Array.from({ length: 60 }, (_, i) => ({ company: `E ${i}`, score: { final: 90, location_bucket: "sao_paulo" } })), profile).mix));
check("feed encolhe em vez de encher de Sao Paulo", (() => {
  const pool = [
    ...Array.from({ length: 6 }, (_, i) => ({ company: `SJRP ${i}`, score: { final: 70, location_bucket: "sjrp" } })),
    ...Array.from({ length: 60 }, (_, i) => ({ company: `SP ${i}`, score: { final: 95, location_bucket: "sao_paulo" } }))
  ];
  const r = applyQuotas(pool, profile);
  return r.selected.length < profile.filters.feed_size && (r.mix.sjrp || 0) === 6;
})());

console.log("\n3f. Chave da Anthropic e modo so-CV");
const aiSrc = await fs.readFile(path.join(ROOT, "pipeline/lib/ai.mjs"), "utf8");
check("envia anthropic-workspace-id quando o secret existe", aiSrc.includes("anthropic-workspace-id") && aiSrc.includes("ANTHROPIC_WORKSPACE_ID"));
check("gerador aceita modo somente CV", aiSrc.includes("includeCoverLetter"));
const tailorSrc = await fs.readFile(path.join(ROOT, "pipeline/tailor.mjs"), "utf8");
check("tailor.mjs le o modo de geracao", tailorSrc.includes("TAILOR_MODE"));
const wfTailor = await fs.readFile(path.join(ROOT, ".github/workflows/tailor.yml"), "utf8");
check("workflow do CV expoe o modo e o workspace id", wfTailor.includes("TAILOR_MODE") && wfTailor.includes("ANTHROPIC_WORKSPACE_ID"));
const wfCollect = await fs.readFile(path.join(ROOT, ".github/workflows/collect.yml"), "utf8");
check("workflow da busca passa o workspace id", wfCollect.includes("ANTHROPIC_WORKSPACE_ID"));

console.log("\n4. Score e hierarquia geografica");
const sSjrp = scoreJob(make({}), profile, { fx });
const sSp = scoreJob(make({ location_raw: "Sao Paulo, SP" }), profile, { fx });
const sSpStrong = scoreJob(make({ title: "Gerente de Operacoes", location_raw: "Sao Paulo, SP" }), profile, { fx });
check("SJRP pontua mais que Sao Paulo com a mesma vaga", sSjrp.score > sSp.score, `${sSjrp.score} vs ${sSp.score}`);
check("Sao Paulo com cargo superior recupera pontos", sSpStrong.components.location > sSp.components.location);
check("score fica entre 0 e 100", sSjrp.score >= 0 && sSjrp.score <= 100, String(sSjrp.score));
check("gera motivos legiveis", sSjrp.reasons.length >= 2, JSON.stringify(sSjrp.reasons));
check("sinaliza salario nao divulgado", sSjrp.flags.some((f) => f.includes("Salario nao divulgado")));

console.log("\n5. Dedup");
const dup = dedupe([
  toCanonicalJob({ title: "Gerente de Operacoes", company: "Alfa", location_raw: "Sao Paulo, SP", description: "curta", url: "https://a.com/1" }, "adzuna_br"),
  toCanonicalJob({ title: "Gerente de Operacoes", company: "Alfa", location_raw: "Sao Paulo, SP", description: "descricao bem mais longa e completa da vaga", url: "https://b.com/1" }, "jooble"),
  toCanonicalJob({ title: "Coordenador de Processos", company: "Beta", location_raw: "Sao Paulo, SP", description: "x", url: "https://c.com/1" }, "gupy")
]);
check("dedup junta a mesma vaga de fontes diferentes", dup.length === 2, `${dup.length} itens`);
check("dedup mantem a descricao mais rica", dup.find((j) => j.company === "Alfa").description.includes("mais longa"));
check("dedup registra as fontes onde a vaga apareceu", (dup.find((j) => j.company === "Alfa").also_seen_in || []).length === 2);
check("dedup nao apaga o salario ao mesclar com uma versao mais longa sem salario", (() => {
  const merged = dedupe([
    toCanonicalJob({ title: "Gerente de Operacoes", company: "Gama", location_raw: "Sao Paulo, SP", description: "Salario de R$ 17.000,00 mensais.", url: "https://a.com/2", posted_at: new Date().toISOString() }, "adzuna_br"),
    toCanonicalJob({ title: "Gerente de Operacoes", company: "Gama", location_raw: "Sao Paulo, SP", description: "Texto muito mais longo do mesmo anuncio, porem sem qualquer mencao a remuneracao publicada.", url: "https://b.com/2" }, "jooble")
  ])[0];
  return merged.salary?.min === 17000 && merged.description.includes("muito mais longo") && merged.posted_at;
})());
check("dedup preserva local quando a outra fonte nao informou", (() => {
  const merged = dedupe([
    toCanonicalJob({ title: "Coordenador de Processos", company: "Delta", location_raw: "", description: "curto", url: "https://a.com/3" }, "rss"),
    toCanonicalJob({ title: "Coordenador de Processos", company: "Delta", location_raw: "Sao Jose do Rio Preto, SP", description: "descricao mais completa do anuncio", url: "https://b.com/3" }, "gupy")
  ])[0];
  return merged.location_raw.includes("Rio Preto");
})());

console.log("\n5b. Casamento de termos por palavra inteira");
check('"ai" nao casa dentro de "mensais"', (() => {
  const r = scoreJob(make({ description: "Coordenar processos. Salario de R$ 16.500,00 mensais." }), profile, { fx });
  return !r.reasons.some((x) => /domina: (.*\b)?ai\b/.test(x));
})(), JSON.stringify(scoreJob(make({ description: "Coordenar processos. Salario de R$ 16.500,00 mensais." }), profile, { fx }).reasons));
check('"ai" casa quando aparece como palavra', (() => {
  const r = scoreJob(make({ description: "Projetos de AI e automacao com Power BI." }), profile, { fx });
  return r.reasons.some((x) => x.includes("Skills tecnicas"));
})());
check("a vaga ideal em SJRP fica com score alto", (() => {
  const r = scoreJob(make({
    title: "Coordenador de Operacoes",
    location_raw: "Sao Jose do Rio Preto, SP",
    description: "Coordenar operacoes e processos da planta de alimentos. Gestao por indicadores, Power BI e SQL, melhoria continua. Salario de R$ 16.500,00 mensais."
  }), profile, { fx });
  return r.score >= 85;
})(), String(scoreJob(make({ title: "Coordenador de Operacoes", location_raw: "Sao Jose do Rio Preto, SP", description: "Coordenar operacoes e processos da planta de alimentos. Gestao por indicadores, Power BI e SQL, melhoria continua. Salario de R$ 16.500,00 mensais." }), profile, { fx }).score));

console.log("\n6. Cotas do feed");
const pool = [];
for (let i = 0; i < 40; i += 1) pool.push({ company: `SJRP ${i}`, score: { final: 90 - i, location_bucket: "sjrp" } });
for (let i = 0; i < 40; i += 1) pool.push({ company: `INTL ${i}`, score: { final: 88 - i, location_bucket: "remote_intl" } });
for (let i = 0; i < 40; i += 1) pool.push({ company: `SP ${i}`, score: { final: 95 - i, location_bucket: "sao_paulo" } });
const quota = applyQuotas(pool, profile);
check("feed respeita o tamanho configurado", quota.selected.length === profile.filters.feed_size, String(quota.selected.length));
check("Sao Paulo nao domina o feed mesmo com scores maiores", (quota.mix.sao_paulo || 0) <= Math.ceil(profile.filters.feed_size * 0.2), JSON.stringify(quota.mix));
check("SJRP e o maior bloco do feed", (quota.mix.sjrp || 0) >= (quota.mix.remote_intl || 0) && (quota.mix.sjrp || 0) >= (quota.mix.sao_paulo || 0), JSON.stringify(quota.mix));
check("teto por empresa e respeitado", (() => {
  const repeated = Array.from({ length: 20 }, (_, i) => ({ company: "Mesma Empresa", score: { final: 90 - i, location_bucket: "sjrp" } }));
  return applyQuotas(repeated, profile).selected.length <= profile.filters.max_per_company;
})());
check("segunda passada completa o feed quando uma regiao nao tem oferta", (() => {
  const onlySjrp = Array.from({ length: 60 }, (_, i) => ({ company: `Empresa ${i}`, score: { final: 90, location_bucket: "sjrp" } }));
  return applyQuotas(onlySjrp, profile).selected.length === profile.filters.feed_size;
})());

console.log("\n7. Parser de resposta da IA");
check("extrai JSON de bloco markdown", (() => {
  const parsed = extractJson('Segue:\n```json\n[{"id":"a","ai_score":80}]\n```\nfim');
  return Array.isArray(parsed) && parsed[0].ai_score === 80;
})());
check("extrai JSON sem cerca", Array.isArray(extractJson('[{"id":"b","ai_score":10}]')));
check("devolve null quando nao ha JSON", extractJson("desculpe, nao consegui") === null);

console.log("\n8. Custo e modelos");
const pricing = searchConfig.ai_pricing_usd_per_mtok || {};
check("tabela de precos existe", Object.keys(pricing).length >= 2, Object.keys(pricing).join(","));
check("modelo do ranking esta na tabela de precos", Boolean(pricing[profile.ai_ranking.model]), profile.ai_ranking.model);
check("modelo do CV e carta esta na tabela de precos", Boolean(pricing[profile.ai_tailoring.model]), profile.ai_tailoring.model);
check("calcula custo corretamente", (() => {
  const c = estimateCost({ model: "claude-sonnet-5", inputTokens: 1e6, outputTokens: 1e5, pricing });
  return Math.abs(c - (2 + 1)) < 1e-9;
})(), String(estimateCost({ model: "claude-sonnet-5", inputTokens: 1e6, outputTokens: 1e5, pricing })));
check("custo devolve null para modelo desconhecido", estimateCost({ model: "inexistente", inputTokens: 1000, pricing }) === null);

console.log("\n9. Regressoes de conector");
// Comentarios sao removidos antes de checar: eles citam os parametros errados
// justamente para documentar o bug, e nao devem contar como uso.
const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const adzunaSrc = codeOnly(await fs.readFile(path.join(ROOT, "pipeline/sources/adzuna.mjs"), "utf8"));
check("adzuna nao envia content_type (causava HTTP 400)", !adzunaSrc.includes("content_type"));
check("adzuna usa o parametro documentado 'what'", /p\.set\("what",/.test(adzunaSrc) && !adzunaSrc.includes("what_phrase"));
const gupySrc = codeOnly(await fs.readFile(path.join(ROOT, "pipeline/sources/gupy.mjs"), "utf8"));
check("gupy nao filtra por cidade na API (acentos quebravam a busca)", !/city:/.test(gupySrc) && !/set\("city"/.test(gupySrc));
const utilSrc = await fs.readFile(path.join(ROOT, "pipeline/lib/util.mjs"), "utf8");
check("erros HTTP carregam o corpo da resposta", utilSrc.includes("resposta: ${body}"));

console.log("\n10. Workflows sem agendamento");
for (const wf of ["collect.yml", "tailor.yml", "diagnose.yml"]) {
  const text = await fs.readFile(path.join(ROOT, ".github/workflows", wf), "utf8");
  const active = text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  check(`${wf} nao tem gatilho de agendamento`, !/^\s*schedule:/m.test(active) && !/^\s*-\s*cron:/m.test(active));
  check(`${wf} usa actions atualizadas`, active.includes("@v5"));
}

console.log(`\n=====================\n${passed} verificacoes ok, ${failures.length} falha(s).`);
if (failures.length) {
  console.error("\nFalhas:");
  failures.forEach((f) => console.error(` - ${f}`));
  process.exit(1);
}
