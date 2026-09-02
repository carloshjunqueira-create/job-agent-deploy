#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function absolutePath(relativeOrAbsolute) {
  return path.isAbsolute(relativeOrAbsolute) ? relativeOrAbsolute : path.join(root, relativeOrAbsolute);
}

function readJson(relativeOrAbsolute) {
  const filename = absolutePath(relativeOrAbsolute);
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function writeJson(relativeOrAbsolute, value) {
  const filename = absolutePath(relativeOrAbsolute);
  fs.mkdirSync(path.dirname(filename), {recursive: true});
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textOf(value) {
  if (Array.isArray(value)) return value.join(' ');
  if (value && typeof value === 'object') return Object.values(value).join(' ');
  return String(value || '');
}

function jobText(job) {
  return normalize([
    job.title,
    job.company,
    job.location,
    job.description,
    textOf(job.requirements),
    textOf(job.preferred_requirements),
    textOf(job.extracted_skills)
  ].join(' '));
}

function titleText(job) { return normalize([job.title, job.seniority].join(' ')); }

function hasTerm(text, term) {
  const normalizedTerm = normalize(term);
  if (!normalizedTerm) return false;
  const escaped = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(?=\\s|$)`).test(text);
}

function hits(text, terms) { return (terms || []).filter((term) => hasTerm(text, term)); }

function unique(values) { return [...new Set((values || []).filter(Boolean))]; }

function numberFromSalary(salary) {
  if (typeof salary === 'number') return {min: salary, max: salary};
  if (!salary || typeof salary !== 'object') return null;
  const toNumber = (value) => value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
  const min = toNumber(salary.min);
  const max = toNumber(salary.max) ?? min;
  if (min === null && max === null) return null;
  return {min: min ?? max, max: max ?? min};
}

function numeric(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function scoreOf(job, key) { return numeric(job.scoring?.[key] ?? job[key], 0); }

function sourceUrlFor(job) { return job.source_url || job.job_url || job.url || job.application_url || ''; }

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function classifyLinkType(job, url) {
  const declared = String(job.source_type || job.link_type || '').toUpperCase();
  if (declared.includes('COMPANY')) return 'COMPANY_PAGE';
  try {
    return new URL(url).pathname.toLowerCase().includes('/company/') ? 'COMPANY_PAGE' : 'JOB_PAGE';
  } catch {
    return 'MISSING';
  }
}

function explicitPreferences(rawPreferences) {
  const explicit = Object.fromEntries((rawPreferences.explicit_preferences || []).map((item) => [item.preference_id, item.value]));
  const mustHave = Object.fromEntries((rawPreferences.must_have || []).map((item) => [item.preference_id, item]));
  return {raw: rawPreferences.preferences || rawPreferences, explicit, mustHave};
}

function preferenceConfig(rawPreferences, rules) {
  const {raw, explicit, mustHave} = explicitPreferences(rawPreferences);
  const configuredLocations = Array.isArray(raw.locations) && raw.locations.length
    ? raw.locations
    : (explicit.EXP009 && typeof explicit.EXP009 === 'object'
      ? Object.entries(explicit.EXP009).map(([name, ratio]) => ({name, enabled: true, percentage: Number(ratio) * 100}))
      : []);
  const allowedExact = rules.location?.allowed_cities_exact || [
    `${rules.location?.primary_city}, SP`,
    `${rules.location?.secondary_city}, SP`
  ];
  const allowedSet = new Set(allowedExact.map(normalize));
  const locations = configuredLocations.length
    ? configuredLocations.filter((location) => allowedSet.has(normalize(location.name))).map((location) => ({
      name: allowedExact.find((candidate) => normalize(candidate) === normalize(location.name)) || location.name,
      enabled: location.enabled !== false,
      percentage: numeric(location.percentage, 0)
    }))
    : allowedExact.map((name, index) => ({name, enabled: true, percentage: index === 0 ? 80 : 20}));
  for (const name of allowedExact) {
    if (!locations.some((location) => normalize(location.name) === normalize(name))) locations.push({name, enabled: false, percentage: 0});
  }
  const primaryName = `${rules.location?.primary_city || 'São José do Rio Preto'}, SP`;
  const secondaryName = `${rules.location?.secondary_city || 'São Paulo'}, SP`;
  const targetRoles = raw.targetRoles || explicit.EXP001 || mustHave.MUST001?.value || rules.target_roles?.primary || [];
  const priorityIndustries = raw.priorityIndustries || explicit.EXP002 || [];
  const dealBreaker = (rawPreferences.deal_breakers || []).find((item) => item.preference_id === 'DB001');
  const exclusions = unique([...(raw.exclusions || dealBreaker?.value || []), 'prospecção', 'hunter', 'vendas']);
  const minimumSalary = numeric(raw.minimumSalary, numeric(mustHave.MUST002?.value, numeric(explicit.MUST002, rules.salary?.minimum || 15000)));
  const targetSalary = numeric(raw.targetSalary, numeric(mustHave.MUST003?.value, numeric(explicit.MUST003, rules.salary?.target || 18000)));
  const enabled = locations.filter((location) => location.enabled && location.percentage > 0);
  const primary = locations.find((location) => normalize(location.name) === normalize(primaryName)) || {name: primaryName, enabled: true, percentage: 80};
  const secondary = locations.find((location) => normalize(location.name) === normalize(secondaryName)) || {name: secondaryName, enabled: true, percentage: 20};
  const activeLocations = enabled.length ? enabled : [primary, secondary];
  return {
    allowedLocations: activeLocations.map((location) => location.name),
    targetMix: Object.fromEntries(activeLocations.map((location) => [location.name, location.percentage / 100])),
    primaryName,
    secondaryName,
    primaryRatio: primary.enabled ? primary.percentage / 100 : 1,
    secondaryRatio: secondary.enabled ? secondary.percentage / 100 : 0,
    targetRoles: Array.isArray(targetRoles) ? targetRoles : [targetRoles],
    priorityIndustries: Array.isArray(priorityIndustries) ? priorityIndustries : [priorityIndustries],
    exclusions,
    minimumSalary,
    targetSalary,
    employmentType: raw.employmentType || mustHave.MUST002?.employment_type || explicit.MUST002?.employment_type || rules.salary?.employment_type || 'CLT',
    locations
  };
}

function parseArgs(argv) {
  const args = {
    input: 'jobs/phase1_scored_jobs.json',
    output: 'jobs/phase2_feed.json',
    previousFeed: 'jobs/phase2_feed.json',
    preferences: 'config/search_preferences.json',
    rules: 'config/scoring_rules.json',
    limit: 15,
    historyLimit: 25,
    minFit: null,
    family: 'nova família'
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--input') args.input = argv[++index];
    else if (flag === '--output') args.output = argv[++index];
    else if (flag === '--previous-feed') args.previousFeed = argv[++index];
    else if (flag === '--no-previous-feed') args.previousFeed = null;
    else if (flag === '--preferences') args.preferences = argv[++index];
    else if (flag === '--rules') args.rules = argv[++index];
    else if (flag === '--limit') args.limit = numeric(argv[++index], 15);
    else if (flag === '--history-limit') args.historyLimit = numeric(argv[++index], 25);
    else if (flag === '--min-fit') args.minFit = numeric(argv[++index], null);
    else if (flag === '--family') args.family = argv[++index];
    else if (flag === '--help' || flag === '-h') {
      console.log('Uso: node engine/build_phase2_feed.js [--input ARQUIVO] [--output ARQUIVO] [--previous-feed ARQUIVO] [--family NOME] [--limit 15] [--min-fit 60]');
      process.exit(0);
    }
  }
  return args;
}

function statusFor(job) {
  const status = String(job.status || '').toUpperCase();
  if (status === 'APPLIED') return 'APPLIED';
  if (status === 'CLOSED') return 'CLOSED';
  return 'OPEN_UNVERIFIED';
}

function mergePreviousStatuses(rawJobs, previousFeed) {
  const previousJobs = Array.isArray(previousFeed?.jobs) ? previousFeed.jobs : [];
  const previousById = new Map(previousJobs.filter((job) => job.job_id).map((job) => [job.job_id, job]));
  const incomingIds = new Set(rawJobs.map((job) => job.job_id).filter(Boolean));
  const hydrated = rawJobs.map((job) => {
    const previous = previousById.get(job.job_id);
    const previousStatus = previous ? statusFor(previous) : 'OPEN_UNVERIFIED';
    const currentStatus = statusFor(job);
    if (currentStatus === 'OPEN_UNVERIFIED' && ['APPLIED', 'CLOSED'].includes(previousStatus)) return {...previous, ...job, status: previousStatus};
    return job;
  });
  const carryovers = previousJobs.filter((job) => job.job_id && !incomingIds.has(job.job_id) && ['APPLIED', 'CLOSED'].includes(statusFor(job)));
  return {jobs: [...hydrated, ...carryovers], inherited: carryovers.length};
}

function isSecondarySuperior(job, rules, preferences) {
  const title = titleText(job);
  const titleSignals = rules.location?.secondary_superiority_title_signals || ['gerente', 'manager', 'principal', 'lead', 'head', 'diretor', 'director'];
  const salary = numberFromSalary(job.salary);
  const salaryThreshold = numeric(preferences.targetSalary, numeric(rules.location?.secondary_superiority_salary_threshold, 18000));
  const scoringSignals = job.scoring?.matched_signals || job.matched_signals || [];
  return hits(title, titleSignals).length > 0 || Boolean(salary && salary.max >= salaryThreshold) || scoringSignals.some((signal) => normalize(signal).includes('oportunidade superior'));
}

function exclusionReason(job, rules, preferences) {
  const text = jobText(job);
  const title = titleText(job);
  const negativeTerms = unique([...(rules.exclusion_signals?.commercial_prospecting_heavy || []), ...preferences.exclusions]);
  const titleHits = hits(title, negativeTerms);
  const bodyHits = hits(text, negativeTerms);
  const operationsTerms = rules.exclusion_signals?.keep_when_operations_is_primary || ['operações', 'operations', 'processos', 'indicadores'];
  const operationsPrimary = hits(title, operationsTerms).length > 0;
  if (titleHits.length) return `sinal comercial no título: ${titleHits.join(', ')}`;
  if (bodyHits.length && !operationsPrimary) return `sinal comercial/prospecção: ${unique(bodyHits).join(', ')}`;
  return null;
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
  reasons.push(isPrimary ? 'São José do Rio Preto é o mercado principal' : 'São Paulo passou pela regra de oportunidade superior');
  return unique(reasons).slice(0, 5);
}

function buildGaps(job) {
  const gaps = job.gaps || job.scoring?.gaps || [];
  return Array.isArray(gaps) ? gaps : [String(gaps)];
}

function normalizeCandidate(job, index, rules, preferences, minFit) {
  const location = String(job.location || '').trim();
  const locationKey = normalize(location);
  const matchedLocation = preferences.allowedLocations.find((allowed) => normalize(allowed) === locationKey);
  if (!matchedLocation) return {excluded: 'location_not_allowed', id: job.job_id || `ROW-${index + 1}`};
  const status = statusFor(job);
  const salary = numberFromSalary(job.salary);
  if (salary && salary.max < preferences.minimumSalary) return {excluded: 'salary_below_minimum', id: job.job_id || `ROW-${index + 1}`};
  const title = titleText(job);
  if (hits(title, ['product manager', 'product owner', 'product management', 'gerente de produto', 'gestor de produto']).length) return {excluded: 'product_management_not_target', id: job.job_id || `ROW-${index + 1}`};
  const commercialReason = exclusionReason(job, rules, preferences);
  if (commercialReason) return {excluded: 'commercial_prospecting', reason: commercialReason, id: job.job_id || `ROW-${index + 1}`};
  const fitScore = scoreOf(job, 'fit_score');
  if (status === 'OPEN_UNVERIFIED' && fitScore < minFit) return {excluded: 'below_min_fit', id: job.job_id || `ROW-${index + 1}`};
  const rawUrl = sourceUrlFor(job);
  const sourceUrl = validHttpUrl(rawUrl);
  const linkType = classifyLinkType(job, rawUrl);
  if (status === 'OPEN_UNVERIFIED' && !sourceUrl) return {excluded: 'missing_link', id: job.job_id || `ROW-${index + 1}`};
  const primary = matchedLocation === preferences.primaryName;
  const secondary = matchedLocation === preferences.secondaryName;
  const superior = secondary ? isSecondarySuperior(job, rules, preferences) : false;
  const roleHits = hits(jobText(job), preferences.targetRoles);
  const industryHits = hits(jobText(job), preferences.priorityIndustries);
  const opportunityScore = scoreOf(job, 'opportunity_score');
  const rankingScore = opportunityScore + Math.min(roleHits.length, 3) * 2 + Math.min(industryHits.length, 2) * 2 - (linkType === 'COMPANY_PAGE' ? 10 : 0);
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
    rankingScore,
    roleHits,
    industryHits
  };
}

function sortCandidates(a, b) {
  return (b.rankingScore - a.rankingScore) || (b.opportunityScore - a.opportunityScore) || (b.fitScore - a.fitScore);
}

function deduplicateJobs(jobs) {
  const uniqueJobs = new Map();
  for (const job of jobs) {
    const key = job.job_id || sourceUrlFor(job) || `${job.title || ''}|${job.company || ''}|${job.location || ''}`;
    const previous = uniqueJobs.get(key);
    if (!previous || scoreOf(job, 'opportunity_score') > scoreOf(previous, 'opportunity_score')) uniqueJobs.set(key, job);
  }
  return [...uniqueJobs.values()];
}

function take(pool, count, selected) {
  for (const candidate of pool.sort(sortCandidates)) {
    if (selected.length >= count || selected.some((item) => item.id === candidate.id)) continue;
    selected.push(candidate);
  }
}

function feedJob(candidate, preferences) {
  const job = candidate.raw;
  const sourceType = candidate.linkType === 'COMPANY_PAGE' ? 'COMPANY_PAGE' : (job.source_type || 'JOB_PAGE');
  return {
    job_id: candidate.id,
    title: job.title || 'Título não informado',
    company: job.company || 'Empresa não informada',
    location: candidate.location,
    work_model: job.work_model || 'UNKNOWN',
    employment_type: job.employment_type || preferences.employmentType || 'UNKNOWN',
    seniority: job.seniority || 'UNKNOWN',
    status: candidate.status,
    source: job.source || 'Fonte pública',
    source_type: sourceType,
    source_url: candidate.sourceUrl,
    publication_age_days: numeric(job.publication_age_days),
    candidate_count: job.candidate_count ?? null,
    salary: job.salary ?? null,
    fit_score: candidate.fitScore,
    opportunity_score: candidate.opportunityScore,
    suggested_cv: job.suggested_cv || job.scoring?.suggested_cv || 'business_consulting',
    why_it_fits: buildWhyItFits(job, preferences, candidate.primary),
    gaps: buildGaps(job),
    requirements: Array.isArray(job.requirements) ? job.requirements : []
  };
}

function currentMix(jobs, primaryName, secondaryName) {
  const active = jobs.filter((job) => !['APPLIED', 'CLOSED'].includes(job.status));
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = readJson(args.input);
  const previousFeed = args.previousFeed && fs.existsSync(absolutePath(args.previousFeed)) ? readJson(args.previousFeed) : null;
  const rawPreferences = readJson(args.preferences);
  const rules = readJson(args.rules);
  const preferences = preferenceConfig(rawPreferences, rules);
  const minFit = args.minFit ?? Math.min(...(rules.fit_bands || []).filter((band) => band.default_action !== 'HIDE_BY_DEFAULT').map((band) => band.minimum), 60);
  const mixTotal = Object.values(preferences.targetMix).reduce((total, ratio) => total + Number(ratio || 0), 0);
  if (Math.abs(mixTotal - 1) > 0.001) throw new Error('A soma das proporções de localidade deve ser 100%.');
  const rawJobs = Array.isArray(input.jobs) ? input.jobs : [];
  const merged = mergePreviousStatuses(rawJobs, previousFeed);
  const deduplicatedJobs = deduplicateJobs(merged.jobs);
  const report = {considered: rawJobs.length, inherited_terminal: merged.inherited, duplicates_removed: merged.jobs.length - deduplicatedJobs.length, excluded: {}};
  const candidates = deduplicatedJobs.map((job, index) => normalizeCandidate(job, index, rules, preferences, minFit));
  const eligible = candidates.filter((candidate) => {
    if (!candidate.excluded) return true;
    report.excluded[candidate.excluded] = (report.excluded[candidate.excluded] || 0) + 1;
    return false;
  });
  const terminal = eligible.filter((candidate) => ['APPLIED', 'CLOSED'].includes(candidate.status)).sort(sortCandidates).slice(0, args.historyLimit);
  const active = eligible.filter((candidate) => !['APPLIED', 'CLOSED'].includes(candidate.status));
  const primaryPool = active.filter((candidate) => candidate.primary);
  const secondaryPool = active.filter((candidate) => candidate.secondary && candidate.superior);
  const selectedActive = [];
  const primaryQuota = Math.round(args.limit * preferences.primaryRatio);
  const secondaryQuota = Math.max(0, args.limit - primaryQuota);
  take(primaryPool, primaryQuota, selectedActive);
  take(secondaryPool, secondaryQuota, selectedActive);
  const remaining = active.filter((candidate) => !selectedActive.some((item) => item.id === candidate.id) && (candidate.primary || (candidate.secondary && candidate.superior)));
  take(remaining, args.limit, selectedActive);
  const selected = [...selectedActive, ...terminal].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'OPEN_UNVERIFIED' ? -1 : 1;
    return sortCandidates(a, b);
  });
  const jobs = selected.map((candidate) => feedJob(candidate, preferences));
  const feed = {
    schema_version: '0.2.0',
    phase: 2,
    refreshed_at: new Date().toISOString().slice(0, 10),
    source_note: `Feed gerado automaticamente para a família “${args.family}”. Vagas, status, salário e regime devem ser confirmados na fonte pública antes da candidatura.`,
    feed_policy: {
      allowed_locations: preferences.allowedLocations,
      target_mix: preferences.targetMix,
      current_mix: currentMix(jobs, preferences.primaryName, preferences.secondaryName),
      salary_reference: {minimum: preferences.minimumSalary, target: preferences.targetSalary, currency: 'BRL', period: 'monthly', employment_type: preferences.employmentType},
      excluded_role_family: 'sales_prospecting_heavy',
      secondary_city_requires_superiority_signal: true,
      generated_from: args.input,
      previous_feed: args.previousFeed,
      scoring_rules: args.rules,
      preferences_source: args.preferences
    },
    jobs
  };
  writeJson(args.output, feed);
  const selectedActiveCount = jobs.filter((job) => !['APPLIED', 'CLOSED'].includes(job.status)).length;
  report.selected_active = selectedActiveCount;
  report.preserved_terminal = jobs.length - selectedActiveCount;
  report.output = args.output;
  report.family = args.family;
  report.min_fit = minFit;
  report.target_mix = preferences.targetMix;
  report.current_mix = feed.feed_policy.current_mix;
  report.not_selected = active.length - selectedActive.length;
  report.note = 'O frontend lê este arquivo; candidaturas continuam sendo ações humanas fora do agente.';
  console.log(JSON.stringify(report, null, 2));
}

main();
