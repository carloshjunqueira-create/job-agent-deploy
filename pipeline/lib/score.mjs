import { norm, clamp, unique, matchTerms } from "./util.mjs";
import { classifyLocation, monthlyBrl } from "./normalize.mjs";

// Casamento por palavra inteira: "ai" nao pode casar dentro de "mensais".
const hit = (haystack, terms = []) => matchTerms(haystack, terms);

/**
 * Score deterministico 0-100. Rapido, roda em todas as vagas e serve de primeiro corte.
 * Devolve tambem os motivos, para o feed explicar a nota mesmo sem a IA.
 */
export function scoreJob(job, profile, options = {}) {
  const fx = options.fx || { BRL: 1 };
  const weights = profile.weights || {};
  const title = norm(job.title);
  const text = norm(`${job.title} ${job.description || ""}`);
  const components = {};
  const reasons = [];
  const flags = [];

  // --- Filtros duros -------------------------------------------------------
  const bucket = classifyLocation(job, profile);
  if (!bucket) {
    return { blocked: true, block_reason: "LOCALIZACAO_FORA_DOS_CRITERIOS", score: 0, components, reasons, flags, location_bucket: null };
  }

  const seniorityExcluded = hit(title, profile.seniority?.exclude_titles || []);
  if (seniorityExcluded.length) {
    return { blocked: true, block_reason: `SENIORIDADE_EXCLUIDA:${seniorityExcluded[0]}`, score: 0, components, reasons, flags, location_bucket: bucket.id };
  }

  const dealTitle = hit(title, profile.deal_breakers?.title_terms || []);
  const dealDesc = hit(text, profile.deal_breakers?.description_terms || []);
  const rescue = hit(text, profile.deal_breakers?.keep_when_present || []);

  // Titulo comercial bloqueia, com uma excecao: quando o proprio titulo tambem
  // carrega um termo de planejamento ou operacao. "Coordenador de Planejamento
  // de Vendas (S&OP)" e uma vaga de operacoes, nao de vender.
  const titleRescue = hit(title, profile.deal_breakers?.title_rescue_when_present || []);
  if (dealTitle.length && !titleRescue.length) {
    return { blocked: true, block_reason: `FOCO_COMERCIAL_NO_TITULO:${dealTitle[0]}`, score: 0, components, reasons, flags, location_bucket: bucket.id };
  }
  if (dealTitle.length) {
    flags.push(`Titulo cita ${dealTitle[0]}, mas tambem ${titleRescue[0]} - confirmar se o foco e operacao ou venda`);
  }
  // Sinais comerciais so na descricao podem ser resgatados quando a vaga e claramente de operacoes.
  if (dealDesc.length >= 2 && rescue.length < 2) {
    return { blocked: true, block_reason: `FOCO_COMERCIAL_NA_DESCRICAO:${dealDesc[0]}`, score: 0, components, reasons, flags, location_bucket: bucket.id };
  }
  if (dealDesc.length >= 2) {
    flags.push(`Descricao menciona ${dealDesc.slice(0, 2).join(" e ")} - confirmar que o foco nao e comercial`);
  }
  if (hit(norm(job.company), profile.deal_breakers?.companies_blocked || []).length) {
    return { blocked: true, block_reason: "EMPRESA_BLOQUEADA", score: 0, components, reasons, flags, location_bucket: bucket.id };
  }

  const maxAge = profile.filters?.recency_days_max ?? 60;
  if (job.age_days != null && job.age_days > maxAge) {
    return { blocked: true, block_reason: `VAGA_ANTIGA:${job.age_days}d`, score: 0, components, reasons, flags, location_bucket: bucket.id };
  }

  // --- Cargo ---------------------------------------------------------------
  // Os cargos do exterior contam tanto quanto os do Brasil. Antes so a lista
  // brasileira valia, e "Management Consultant" perdia pontos por isso.
  const allQueries = [...(profile.queries || []), ...(profile.queries_international || [])];
  const roleHits = hit(title, allQueries);
  const mustHits = hit(title, profile.must_have_any || []);
  let roleRatio = 0;
  if (roleHits.length) roleRatio = 1;
  else if (mustHits.length >= 2) roleRatio = 0.85;
  else if (mustHits.length === 1) roleRatio = 0.6;
  else if (hit(text, profile.must_have_any || []).length >= 3) roleRatio = 0.35;
  components.role = Math.round((weights.role || 0) * roleRatio);
  if (roleRatio >= 0.85) reasons.push(`Titulo alinhado aos cargos-alvo: "${job.title}"`);
  else if (roleRatio > 0) flags.push("Titulo so parcialmente alinhado aos cargos-alvo");

  // --- Experiencia / conteudo ----------------------------------------------
  const contentHits = unique(hit(text, profile.must_have_any || []));
  const expRatio = clamp(contentHits.length / 5, 0, 1);
  components.experience = Math.round((weights.experience || 0) * expRatio);
  if (contentHits.length >= 3) reasons.push(`Descricao cobre temas do seu repertorio: ${contentHits.slice(0, 4).join(", ")}`);

  // --- Skills --------------------------------------------------------------
  const high = unique(hit(text, profile.skills_boost?.high || []));
  const medium = unique(hit(text, profile.skills_boost?.medium || []));
  const langs = unique(hit(text, profile.skills_boost?.languages || []));
  const skillRatio = clamp((high.length * 0.22) + (medium.length * 0.1) + (langs.length * 0.12), 0, 1);
  components.skills = Math.round((weights.skills || 0) * skillRatio);
  if (high.length) reasons.push(`Skills tecnicas que voce domina: ${high.slice(0, 4).join(", ")}`);
  if (langs.length) reasons.push(`Pede idioma que voce fala: ${langs.join(", ")}`);

  // --- Senioridade ---------------------------------------------------------
  const seniorHits = hit(title, profile.seniority?.prefer || []);
  const seniorRatio = seniorHits.length ? 1 : (hit(text, profile.seniority?.prefer || []).length ? 0.5 : 0.3);
  components.seniority = Math.round((weights.seniority || 0) * seniorRatio);

  // --- Industria -----------------------------------------------------------
  const industryText = norm(`${job.company} ${job.description || ""}`);
  const priorityIndustry = unique(hit(industryText, profile.industries?.priority || []));
  const neutralIndustry = unique(hit(industryText, profile.industries?.neutral || []));
  const industryRatio = priorityIndustry.length ? 1 : (neutralIndustry.length ? 0.55 : 0.3);
  components.industry = Math.round((weights.industry || 0) * industryRatio);
  if (priorityIndustry.length) reasons.push(`Industria prioritaria: ${priorityIndustry.slice(0, 2).join(", ")}`);

  // --- Salario -------------------------------------------------------------
  const salaryCfg = profile.salary || {};
  const brl = monthlyBrl(job.salary, fx);
  let salaryRatio;
  let salaryBlocked = false;
  if (brl == null) {
    salaryRatio = 0.5;
    flags.push("Salario nao divulgado - confirmar na candidatura");
  } else if (brl < (salaryCfg.min_brl_monthly ?? 0)) {
    salaryRatio = 0;
    salaryBlocked = salaryCfg.below_minimum_action === "BLOCK";
  } else if (brl >= (salaryCfg.target_brl_monthly ?? Infinity)) {
    salaryRatio = 1;
    reasons.push(`Salario publicado acima do alvo (~R$ ${brl.toLocaleString("pt-BR")}/mes)`);
  } else {
    const min = salaryCfg.min_brl_monthly ?? 0;
    const target = salaryCfg.target_brl_monthly ?? min + 1;
    salaryRatio = 0.6 + 0.4 * clamp((brl - min) / (target - min), 0, 1);
    reasons.push(`Salario publicado acima do piso (~R$ ${brl.toLocaleString("pt-BR")}/mes)`);
  }
  if (salaryBlocked) {
    return { blocked: true, block_reason: `SALARIO_ABAIXO_DO_PISO:${brl}`, score: 0, components, reasons, flags, location_bucket: bucket.id, salary_brl_monthly: brl };
  }
  components.salary = Math.round((weights.salary || 0) * salaryRatio);
  if (brl == null && salaryCfg.unknown_salary_penalty) {
    components.salary -= salaryCfg.unknown_salary_penalty;
  }

  // --- Localizacao ---------------------------------------------------------
  let locationRatio = bucket.weight ?? 1;
  const superiority = bucket.superiority_rule;
  if (superiority?.enabled) {
    const strongTitle = hit(title, superiority.title_signals || []).length > 0;
    const strongSalary = brl != null && brl >= (superiority.min_salary_brl ?? Infinity);
    if (!strongTitle && !strongSalary) {
      locationRatio *= 0.45;
      flags.push(`${bucket.label}: so vale se a oportunidade for superior a atual - nao ficou evidente aqui`);
    } else {
      reasons.push(`${bucket.label} com sinal de oportunidade superior`);
    }
  }
  components.location = Math.round((weights.location || 0) * clamp(locationRatio, 0, 1));

  // --- Recencia ------------------------------------------------------------
  let recencyRatio = 0.6;
  if (job.age_days != null) recencyRatio = clamp(1 - job.age_days / (maxAge || 45), 0, 1);
  components.recency = Math.round((weights.recency || 0) * recencyRatio);
  if (job.age_days != null && job.age_days <= 3) reasons.push(`Publicada ha ${job.age_days} dia(s)`);

  const total = Object.values(components).reduce((sum, v) => sum + v, 0);
  const maxTotal = Object.values(weights).reduce((sum, v) => sum + v, 0) || 100;
  const score = clamp(Math.round((total / maxTotal) * 100), 0, 100);

  return {
    blocked: false,
    block_reason: null,
    score,
    components,
    reasons,
    flags,
    location_bucket: bucket.id,
    location_label: bucket.label,
    salary_brl_monthly: brl
  };
}

/** Aplica cotas por regiao e teto por empresa, preservando a ordem de score. */
export function applyQuotas(jobs, profile) {
  const size = profile.filters?.feed_size ?? 40;
  const maxPerCompany = profile.filters?.max_per_company ?? 3;
  const buckets = (profile.locations || []).filter((l) => l.enabled !== false);
  const targets = new Map(buckets.map((b) => [b.id, Math.round(size * (b.quota ?? 0))]));

  // Teto absoluto por regiao. A cota diz o alvo; o teto impede que a segunda
  // passada transforme uma regiao secundaria na maioria do feed quando a
  // regiao principal tem pouca oferta. Sem teto, Sao Paulo ocupou 22 de 45
  // vagas com cota de 7.
  const caps = new Map(buckets.map((b) => [
    b.id,
    b.max_share != null ? Math.max(1, Math.round(size * b.max_share)) : size
  ]));

  const sorted = [...jobs].sort((a, b) => b.score.final - a.score.final);
  const selected = [];
  const chosen = new Set();
  const perBucket = new Map();
  const perCompany = new Map();

  const canTake = (job, ignoreQuota) => {
    const companyCount = perCompany.get(norm(job.company)) || 0;
    if (companyCount >= maxPerCompany) return false;
    const used = perBucket.get(job.score.location_bucket) || 0;
    if (used >= (caps.get(job.score.location_bucket) ?? size)) return false;
    if (ignoreQuota) return true;
    return used < (targets.get(job.score.location_bucket) ?? size);
  };

  const take = (job) => {
    selected.push(job);
    chosen.add(job);
    perBucket.set(job.score.location_bucket, (perBucket.get(job.score.location_bucket) || 0) + 1);
    perCompany.set(norm(job.company), (perCompany.get(norm(job.company)) || 0) + 1);
  };

  for (const job of sorted) {
    if (selected.length >= size) break;
    if (canTake(job, false)) take(job);
  }
  // Segunda passada: se um bucket nao teve oferta suficiente, completa por score puro.
  for (const job of sorted) {
    if (selected.length >= size) break;
    if (chosen.has(job)) continue;
    if (canTake(job, true)) take(job);
  }

  return {
    selected: selected.sort((a, b) => b.score.final - a.score.final),
    mix: Object.fromEntries(perBucket),
    targets: Object.fromEntries(targets),
    caps: Object.fromEntries(caps)
  };
}
