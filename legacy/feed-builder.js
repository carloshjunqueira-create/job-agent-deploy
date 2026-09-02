(function attachFeedBuilder(global) {
  "use strict";

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function textOf(value) {
    if (Array.isArray(value)) return value.join(" ");
    if (value && typeof value === "object") return Object.values(value).join(" ");
    return String(value || "");
  }

  function jobText(job) {
    return normalize([
      job.title,
      job.company,
      job.location,
      job.description,
      textOf(job.requirements),
      textOf(job.preferred_requirements),
      textOf(job.extracted_skills),
      textOf(job.scoring?.matched_signals)
    ].join(" "));
  }

  function titleText(job) { return normalize([job.title, job.seniority].join(" ")); }

  function numeric(value, fallback = null) {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function scoreOf(job, key) { return numeric(job.scoring?.[key] ?? job[key], 0); }

  function hasScore(job, key) { return Number.isFinite(Number(job.scoring?.[key] ?? job[key])); }

  function sourceUrlFor(job) { return job.source_url || job.job_url || job.url || job.application_url || ""; }

  function validHttpUrl(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function classifyLinkType(job, url) {
    const declared = String(job.source_type || job.link_type || "").toUpperCase();
    if (declared.includes("COMPANY")) return "COMPANY_PAGE";
    try {
      return new URL(url).pathname.toLowerCase().includes("/company/") ? "COMPANY_PAGE" : "JOB_PAGE";
    } catch {
      return "MISSING";
    }
  }

  function unique(values) { return [...new Set((values || []).filter(Boolean))]; }

  function hasTerm(text, term) {
    const normalizedTerm = normalize(term);
    if (!normalizedTerm) return false;
    const escaped = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\s)${escaped}(?=\\s|$)`).test(text);
  }

  function hits(text, terms) { return (terms || []).filter((term) => hasTerm(text, term)); }

  function numberFromSalary(salary) {
    if (typeof salary === "number") return {min: salary, max: salary};
    if (!salary || typeof salary !== "object") return null;
    const min = numeric(salary.min);
    const max = numeric(salary.max, min);
    if (min === null && max === null) return null;
    return {min: min ?? max, max: max ?? min};
  }

  function statusFor(job) {
    const status = String(job.status || "").toUpperCase();
    if (status === "APPLIED") return "APPLIED";
    if (status === "CLOSED") return "CLOSED";
    return "OPEN_UNVERIFIED";
  }

  function normalizePreferences(raw, rules) {
    const locationRules = rules.location || {};
    const allowedExact = locationRules.allowed_cities_exact || [
      `${locationRules.primary_city || "São José do Rio Preto"}, SP`,
      `${locationRules.secondary_city || "São Paulo"}, SP`
    ];
    const configured = Array.isArray(raw.locations) ? raw.locations : [];
    const locations = allowedExact.map((name) => {
      const found = configured.find((item) => normalize(item.name) === normalize(name));
      return {
        name,
        enabled: found ? found.enabled !== false : false,
        percentage: found ? numeric(found.percentage, 0) : 0
      };
    });
    if (!locations.some((item) => item.enabled && item.percentage > 0)) {
      locations[0].enabled = true;
      locations[0].percentage = 80;
      if (locations[1]) {
        locations[1].enabled = true;
        locations[1].percentage = 20;
      }
    }
    const active = locations.filter((item) => item.enabled && item.percentage > 0);
    const total = active.reduce((sum, item) => sum + item.percentage, 0);
    if (Math.abs(total - 100) > 0.001) throw new Error("A proporção das cidades deve totalizar 100%.");
    const primaryName = `${locationRules.primary_city || "São José do Rio Preto"}, SP`;
    const secondaryName = `${locationRules.secondary_city || "São Paulo"}, SP`;
    const primary = locations.find((item) => normalize(item.name) === normalize(primaryName));
    const secondary = locations.find((item) => normalize(item.name) === normalize(secondaryName));
    return {
      allowedLocations: active.map((item) => item.name),
      targetMix: Object.fromEntries(active.map((item) => [item.name, item.percentage / 100])),
      primaryName,
      secondaryName,
      primaryRatio: primary?.enabled ? primary.percentage / 100 : 1,
      secondaryRatio: secondary?.enabled ? secondary.percentage / 100 : 0,
      targetRoles: Array.isArray(raw.targetRoles) ? raw.targetRoles : [],
      priorityIndustries: Array.isArray(raw.priorityIndustries) ? raw.priorityIndustries : [],
      exclusions: unique([...(raw.exclusions || []), "prospecção", "hunter", "vendas"]),
      minimumSalary: numeric(raw.minimumSalary, numeric(rules.salary?.minimum, 15000)),
      targetSalary: numeric(raw.targetSalary, numeric(rules.salary?.target, 18000)),
      employmentType: raw.employmentType || rules.salary?.employment_type || "CLT"
    };
  }

  function mergePreviousStatuses(rawJobs, previousFeed) {
    const previousJobs = Array.isArray(previousFeed?.jobs) ? previousFeed.jobs : [];
    const previousById = new Map(previousJobs.filter((job) => job.job_id).map((job) => [job.job_id, job]));
    const incomingIds = new Set(rawJobs.map((job) => job.job_id).filter(Boolean));
    const hydrated = rawJobs.map((job) => {
      const previous = previousById.get(job.job_id);
      const previousStatus = previous ? statusFor(previous) : "OPEN_UNVERIFIED";
      const currentStatus = statusFor(job);
      if (currentStatus === "OPEN_UNVERIFIED" && ["APPLIED", "CLOSED"].includes(previousStatus)) return {...previous, ...job, status: previousStatus};
      return job;
    });
    const carryovers = previousJobs.filter((job) => job.job_id && !incomingIds.has(job.job_id) && ["APPLIED", "CLOSED"].includes(statusFor(job)));
    return {jobs: [...hydrated, ...carryovers], inherited: carryovers.length};
  }

  function isSecondarySuperior(job, rules, preferences) {
    const title = titleText(job);
    const titleSignals = rules.location?.secondary_superiority_title_signals || ["gerente", "manager", "coordenador", "coordenadora", "principal", "lead", "head", "diretor", "director"];
    const salary = numberFromSalary(job.salary);
    const threshold = numeric(preferences.targetSalary, numeric(rules.location?.secondary_superiority_salary_threshold, 18000));
    const scoringSignals = job.scoring?.matched_signals || job.matched_signals || [];
    return hits(title, titleSignals).length > 0 || Boolean(salary && salary.max >= threshold) || scoringSignals.some((signal) => normalize(signal).includes("oportunidade superior"));
  }

  function exclusionReason(job, rules, preferences) {
    const text = jobText(job);
    const title = titleText(job);
    const negativeTerms = unique([...(rules.exclusion_signals?.commercial_prospecting_heavy || []), ...preferences.exclusions]);
    const titleHits = hits(title, negativeTerms);
    const bodyHits = hits(text, negativeTerms);
    const operationsTerms = rules.exclusion_signals?.keep_when_operations_is_primary || ["operações", "operations", "processos", "indicadores", "governança", "planejamento", "transformação", "estratégia"];
    const operationsPrimary = hits(title, operationsTerms).length > 0;
    if (titleHits.length) return `sinal comercial no título: ${titleHits.join(", ")}`;
    if (bodyHits.length && !operationsPrimary) return `sinal comercial/prospecção: ${unique(bodyHits).join(", ")}`;
    return null;
  }

  function normalizeCandidate(job, index, rules, preferences, minFit) {
    const location = String(job.location || "").trim();
    const matchedLocation = preferences.allowedLocations.find((allowed) => normalize(allowed) === normalize(location));
    if (!matchedLocation) return {excluded: "location_not_allowed", id: job.job_id || `ROW-${index + 1}`};
    const status = statusFor(job);
    const salary = numberFromSalary(job.salary);
    if (salary && salary.max < preferences.minimumSalary) return {excluded: "salary_below_minimum", id: job.job_id || `ROW-${index + 1}`};
    const title = titleText(job);
    if (hits(title, ["product manager", "product owner", "product management", "gerente de produto", "gestor de produto"]).length) return {excluded: "product_management_not_target", id: job.job_id || `ROW-${index + 1}`};
    const commercialReason = exclusionReason(job, rules, preferences);
    if (commercialReason) return {excluded: "commercial_prospecting", reason: commercialReason, id: job.job_id || `ROW-${index + 1}`};
    const fitScore = scoreOf(job, "fit_score");
    if (status === "OPEN_UNVERIFIED" && fitScore < minFit) return {excluded: "below_min_fit", id: job.job_id || `ROW-${index + 1}`};
    const rawUrl = sourceUrlFor(job);
    const sourceUrl = validHttpUrl(rawUrl);
    const linkType = classifyLinkType(job, rawUrl);
    if (status === "OPEN_UNVERIFIED" && !sourceUrl) return {excluded: "missing_link", id: job.job_id || `ROW-${index + 1}`};
    const primary = matchedLocation === preferences.primaryName;
    const secondary = matchedLocation === preferences.secondaryName;
    const superior = secondary ? isSecondarySuperior(job, rules, preferences) : false;
    const roleHits = hits(jobText(job), preferences.targetRoles);
    const industryHits = hits(jobText(job), preferences.priorityIndustries);
    const opportunityScore = scoreOf(job, "opportunity_score");
    return {
      raw: job,
      id: job.job_id || `ROW-${index + 1}`,
      location: matchedLocation,
      status,
      sourceUrl,
      linkType,
      primary,
      secondary,
      superior,
      fitScore,
      opportunityScore,
      rankingScore: opportunityScore + Math.min(roleHits.length, 3) * 2 + Math.min(industryHits.length, 2) * 2 - (linkType === "COMPANY_PAGE" ? 10 : 0)
    };
  }

  function sortCandidates(a, b) {
    return (b.rankingScore - a.rankingScore) || (b.opportunityScore - a.opportunityScore) || (b.fitScore - a.fitScore);
  }

  function deduplicateJobs(jobs) {
    const uniqueJobs = new Map();
    for (const job of jobs) {
      const key = job.job_id || sourceUrlFor(job) || `${job.title || ""}|${job.company || ""}|${job.location || ""}`;
      const previous = uniqueJobs.get(key);
      if (!previous || scoreOf(job, "opportunity_score") > scoreOf(previous, "opportunity_score")) uniqueJobs.set(key, job);
    }
    return [...uniqueJobs.values()];
  }

  function take(pool, count, selected) {
    for (const candidate of [...pool].sort(sortCandidates)) {
      if (selected.length >= count || selected.some((item) => item.id === candidate.id)) continue;
      selected.push(candidate);
    }
  }

  function buildWhyItFits(job, preferences, isPrimary) {
    const existing = Array.isArray(job.why_it_fits) ? job.why_it_fits : [];
    if (existing.length) return existing;
    const text = jobText(job);
    const roleHits = hits(text, preferences.targetRoles);
    const industryHits = hits(text, preferences.priorityIndustries);
    const scoringHits = job.scoring?.matched_signals || job.matched_signals || [];
    const reasons = [
      ...roleHits.slice(0, 2).map((hit) => `Cargo relacionado a ${hit}`),
      ...industryHits.slice(0, 2).map((hit) => `Setor prioritário: ${hit}`),
      ...scoringHits.slice(0, 2).map((hit) => `Sinal de aderência: ${hit}`)
    ];
    reasons.push(isPrimary ? "São José do Rio Preto é o mercado principal" : "São Paulo passou pela regra de oportunidade superior");
    return unique(reasons).slice(0, 5);
  }

  function buildGaps(job) {
    const gaps = job.gaps || job.scoring?.gaps || [];
    return Array.isArray(gaps) ? gaps : [String(gaps)];
  }

  function feedJob(candidate, preferences) {
    const job = candidate.raw;
    return {
      job_id: candidate.id,
      title: job.title || "Título não informado",
      company: job.company || "Empresa não informada",
      location: candidate.location,
      work_model: job.work_model || "UNKNOWN",
      employment_type: job.employment_type || preferences.employmentType || "UNKNOWN",
      seniority: job.seniority || "UNKNOWN",
      status: candidate.status,
      source: job.source || "Fonte pública",
      source_type: candidate.linkType === "COMPANY_PAGE" ? "COMPANY_PAGE" : (job.source_type || "JOB_PAGE"),
      source_url: candidate.sourceUrl,
      publication_age_days: numeric(job.publication_age_days),
      candidate_count: job.candidate_count ?? null,
      salary: job.salary ?? null,
      fit_score: candidate.fitScore,
      opportunity_score: candidate.opportunityScore,
      suggested_cv: job.suggested_cv || job.scoring?.suggested_cv || "business_consulting",
      why_it_fits: buildWhyItFits(job, preferences, candidate.primary),
      gaps: buildGaps(job),
      requirements: Array.isArray(job.requirements) ? job.requirements : []
    };
  }

  function currentMix(jobs, primaryName, secondaryName) {
    const active = jobs.filter((job) => !["APPLIED", "CLOSED"].includes(job.status));
    const primary = active.filter((job) => job.location === primaryName).length;
    const secondary = active.filter((job) => job.location === secondaryName).length;
    return {
      active_jobs: active.length,
      counts: {[primaryName]: primary, [secondaryName]: secondary},
      ratios: {
        [primaryName]: active.length ? Number((primary / active.length).toFixed(3)) : 0,
        [secondaryName]: active.length ? Number((secondary / active.length).toFixed(3)) : 0
      }
    };
  }

  function build(input, previousFeed, rawPreferences, rules, options = {}) {
    const rawJobs = Array.isArray(input) ? input : (Array.isArray(input?.jobs) ? input.jobs : []);
    if (!rawJobs.length) throw new Error("Nenhuma vaga foi encontrada no JSON importado.");
    const missingScores = rawJobs.filter((job) => !hasScore(job, "fit_score") || !hasScore(job, "opportunity_score"));
    if (missingScores.length) throw new Error(`O arquivo precisa trazer fit_score e opportunity_score para todas as vagas. ${missingScores.length} vaga(s) estão sem pontuação.`);
    const preferences = normalizePreferences(rawPreferences, rules);
    const minFit = numeric(options.minFit, 60);
    const limit = Math.max(1, numeric(options.limit, 15));
    const historyLimit = Math.max(0, numeric(options.historyLimit, 25));
    const merged = options.useHistory === false ? {jobs: rawJobs, inherited: 0} : mergePreviousStatuses(rawJobs, previousFeed);
    const deduplicatedJobs = deduplicateJobs(merged.jobs);
    const report = {considered: rawJobs.length, inherited_terminal: merged.inherited, duplicates_removed: merged.jobs.length - deduplicatedJobs.length, excluded: {}};
    const candidates = deduplicatedJobs.map((job, index) => normalizeCandidate(job, index, rules, preferences, minFit));
    const eligible = candidates.filter((candidate) => {
      if (!candidate.excluded) return true;
      report.excluded[candidate.excluded] = (report.excluded[candidate.excluded] || 0) + 1;
      return false;
    });
    const terminal = eligible.filter((candidate) => ["APPLIED", "CLOSED"].includes(candidate.status)).sort(sortCandidates).slice(0, historyLimit);
    const active = eligible.filter((candidate) => !["APPLIED", "CLOSED"].includes(candidate.status));
    const primaryPool = active.filter((candidate) => candidate.primary);
    const secondaryPool = active.filter((candidate) => candidate.secondary && candidate.superior);
    const selectedActive = [];
    const primaryQuota = Math.round(limit * preferences.primaryRatio);
    const secondaryQuota = Math.max(0, limit - primaryQuota);
    take(primaryPool, primaryQuota, selectedActive);
    take(secondaryPool, secondaryQuota, selectedActive);
    const remaining = active.filter((candidate) => !selectedActive.some((item) => item.id === candidate.id) && (candidate.primary || (candidate.secondary && candidate.superior)));
    take(remaining, limit, selectedActive);
    const selected = [...selectedActive, ...terminal].sort((a, b) => {
      if (a.status !== b.status) return a.status === "OPEN_UNVERIFIED" ? -1 : 1;
      return sortCandidates(a, b);
    });
    const jobs = selected.map((candidate) => feedJob(candidate, preferences));
    const family = options.family || "nova família";
    const feed = {
      schema_version: "0.2.0",
      phase: 2,
      refreshed_at: new Date().toISOString().slice(0, 10),
      source_note: `Feed gerado no navegador para a família “${family}”. Vagas, status, salário e regime devem ser confirmados na fonte pública antes da candidatura.`,
      feed_policy: {
        allowed_locations: preferences.allowedLocations,
        target_mix: preferences.targetMix,
        current_mix: currentMix(jobs, preferences.primaryName, preferences.secondaryName),
        salary_reference: {minimum: preferences.minimumSalary, target: preferences.targetSalary, currency: "BRL", period: "monthly", employment_type: preferences.employmentType},
        excluded_role_family: "sales_prospecting_heavy",
        secondary_city_requires_superiority_signal: true,
        generated_from: "browser_import",
        previous_feed: options.useHistory === false ? null : "local_feed_and_published_feed",
        preferences_source: "browser_preferences"
      },
      jobs
    };
    const selectedActiveCount = jobs.filter((job) => !["APPLIED", "CLOSED"].includes(job.status)).length;
    report.selected_active = selectedActiveCount;
    report.preserved_terminal = jobs.length - selectedActiveCount;
    report.family = family;
    report.min_fit = minFit;
    report.target_mix = preferences.targetMix;
    report.current_mix = feed.feed_policy.current_mix;
    report.not_selected = active.length - selectedActive.length;
    report.note = "Gerado no navegador; candidaturas continuam sendo ações humanas fora do agente.";
    return {feed, report};
  }

  function slugify(value) {
    return normalize(value).replace(/\s+/g, "-").slice(0, 70) || "nova-familia";
  }

  function buildBriefing({family, objective, preferences, limit = 15}) {
    const cities = (preferences.locations || [])
      .filter((item) => item.enabled && Number(item.percentage) > 0)
      .map((item) => `- ${item.name}: ${item.percentage}%`)
      .join("\n");
    const roles = (preferences.targetRoles || []).map((item) => `- ${item}`).join("\n");
    const industries = (preferences.priorityIndustries || []).map((item) => `- ${item}`).join("\n");
    return [
      "PEDIDO DE COLETA PÚBLICA — FASE 1",
      "",
      `Família da busca: ${family || "nova família"}`,
      `Objetivo: ${objective || "Encontrar vagas aderentes ao perfil profissional informado."}`,
      "",
      "Cargos prioritários:",
      roles,
      "",
      "Indústrias prioritárias:",
      industries,
      "",
      "Localidade e proporção desejada:",
      cities,
      "",
      `Régua: CLT; mínimo de R$ ${Number(preferences.minimumSalary || 15000).toLocaleString("pt-BR")}/mês; alvo de R$ ${Number(preferences.targetSalary || 18000).toLocaleString("pt-BR")}/mês. Excluir funções predominantemente comerciais, de prospecção, hunter e vendas. Não incluir Product Manager/Product Owner.`,
      "",
      "Regras de coleta:",
      "1. Use somente fontes públicas e links HTTP/HTTPS acessíveis. Não faça login, scraping autenticado, automação de candidatura ou uso de cookies/credenciais.",
      "2. Priorize São José do Rio Preto; São Paulo só entra quando houver sinal claro de superioridade, como gerência/coordenação, salário publicado no alvo ou escopo muito superior.",
      "3. Não invente salário, status, requisitos ou links. Se o salário não for publicado, informe null e sinalize a confirmação.",
      "4. Diferencie link de vaga específica de página geral da empresa.",
      `5. Retorne no máximo ${limit} oportunidades após pontuação e triagem.`,
      "",
      "Formato de saída obrigatório (JSON, sem markdown):",
      "{",
      "  \"schema_version\": \"0.1.0\",",
      "  \"jobs\": [",
      "    {",
      "      \"job_id\": \"id-estavel\",",
      "      \"title\": \"...\",",
      "      \"company\": \"...\",",
      "      \"location\": \"São José do Rio Preto, SP\",",
      "      \"work_model\": \"...\",",
      "      \"employment_type\": \"CLT\",",
      "      \"seniority\": \"...\",",
      "      \"source\": \"...\",",
      "      \"source_url\": \"https://...\",",
      "      \"publication_age_days\": null,",
      "      \"candidate_count\": null,",
      "      \"salary\": null,",
      "      \"requirements\": [],",
      "      \"preferred_requirements\": [],",
      "      \"extracted_skills\": [],",
      "      \"scoring\": {",
      "        \"fit_score\": 0,",
      "        \"opportunity_score\": 0,",
      "        \"matched_signals\": [],",
      "        \"gaps\": [],",
      "        \"suggested_cv\": \"business_consulting\"",
      "      }",
      "    }",
      "  ]",
      "}",
      "",
      "Devolva somente o JSON válido, sem bloco markdown e sem explicações fora do JSON."
    ].join("\n");
  }

  global.JobFeedBuilder = {build, buildBriefing, slugify};
})(window);
