#!/usr/bin/env node
/**
 * Auto-teste offline: valida configs, filtros, score, dedup e cotas sem tocar na rede.
 * Roda no CI antes de qualquer coleta. Se este arquivo passa, a logica de triagem esta sa.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toCanonicalJob, dedupe, detectWorkModel, parseSalaryFromText, monthlyBrl } from "./lib/normalize.mjs";
import { scoreJob, applyQuotas } from "./lib/score.mjs";
import { extractJson } from "./lib/ai.mjs";

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
const fx = searchConfig.fx_to_brl;

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
check("aceita remoto internacional", (() => {
  const r = scoreJob(make({ title: "Operations Manager", location_raw: "Remote - Europe", company: "Acme Inc", description: "Remote role. Process improvement, KPIs, SQL and Power BI. English required." }), profile, { fx });
  return r.blocked === false && r.location_bucket === "remote_intl";
})());
check("remoto brasileiro fica fora enquanto o bucket esta desligado", scoreJob(make({ title: "Gerente de Operacoes", location_raw: "Remoto - Brasil", description: "Trabalho remoto em todo o Brasil, processos e indicadores." }), profile, { fx }).blocked === true);

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

console.log(`\n=====================\n${passed} verificacoes ok, ${failures.length} falha(s).`);
if (failures.length) {
  console.error("\nFalhas:");
  failures.forEach((f) => console.error(` - ${f}`));
  process.exit(1);
}
