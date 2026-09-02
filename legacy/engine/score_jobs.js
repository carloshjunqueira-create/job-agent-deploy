#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

const profile = readJson('profile/candidate_profile.json');
const evidenceBank = readJson('profile/evidence_bank.json');
const rules = readJson('config/scoring_rules.json');

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

function matches(text, terms) {
  return (terms || []).filter(term => {
    const normalizedTerm = normalize(term);
    const escaped = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\s)${escaped}(?=\\s|$)`).test(text);
  });
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function numberFromSalary(salary) {
  if (typeof salary === 'number') return { min: salary, max: salary };
  if (!salary || typeof salary !== 'object') return null;
  const min = Number.isFinite(Number(salary.min)) ? Number(salary.min) : null;
  const max = Number.isFinite(Number(salary.max)) ? Number(salary.max) : min;
  if (min === null && max === null) return null;
  return { min: min ?? max, max: max ?? min };
}

function candidateCorpus() {
  const profileSkills = Object.values(profile.technical_skills || {}).flat();
  const evidenceText = evidenceBank.evidence
    .filter(item => item.classification !== 'UNKNOWN')
    .flatMap(item => [item.claim, ...(item.usable_for || []), ...(item.metrics || [])]);
  return normalize([
    profile.professional_summary?.value,
    textOf(profile.experience),
    textOf(profile.education),
    textOf(profile.languages),
    textOf(profileSkills),
    evidenceText.join(' ')
  ].join(' '));
}

const candidateText = candidateCorpus();

function expandedTerms(term) {
  const key = normalize(term);
  const aliases = [];
  for (const [canonical, values] of Object.entries(rules.skill_aliases || {})) {
    const normalizedValues = values.map(normalize);
    if (key === normalize(canonical) || normalizedValues.includes(key) || normalizedValues.some(value => key.includes(value) || value.includes(key))) {
      aliases.push(canonical, ...values);
    }
  }
  return unique([term, ...aliases]);
}

function evidenceCovers(term) {
  return expandedTerms(term).some(candidateTerm => candidateText.includes(normalize(candidateTerm)));
}

function functionComponent(job) {
  const title = normalize(job.title);
  const text = jobText(job);
  const primaryHits = matches(title, rules.target_roles.primary);
  const adjacentHits = matches(title, rules.target_roles.adjacent);
  const contextHits = matches(text, rules.target_roles.strong_business_context);
  const negativeHits = matches(title, rules.target_roles.negative_title_signals);
  if (primaryHits.length && contextHits.length) return { score: 25, matched: unique([...primaryHits, ...contextHits]), gaps: [] };
  if (primaryHits.length) return { score: 22, matched: unique(primaryHits), gaps: ['Escopo de negócios/estratégia não está totalmente claro no título público.'] };
  if (adjacentHits.length) return { score: 18, matched: adjacentHits, gaps: ['Cargo é adjacente às trilhas principais.'] };
  if (negativeHits.length) return { score: 8, matched: [], gaps: [`Sinal de cargo abaixo ou diferente do foco-alvo: ${negativeHits.join(', ')}.`] };
  return { score: 0, matched: [], gaps: ['Título não corresponde às famílias prioritárias.'] };
}

function experienceComponent(job) {
  const requirements = unique([...(job.requirements || [])]);
  if (!requirements.length) return { score: rules.fit_weights.required_experience / 2, matched: [], gaps: ['Requisitos não publicados.'], coverage: null };
  const matched = requirements.filter(evidenceCovers);
  const gaps = requirements.filter(item => !evidenceCovers(item));
  const score = Math.round((matched.length / requirements.length) * rules.fit_weights.required_experience);
  return { score, matched, gaps, coverage: matched.length / requirements.length };
}

function skillsComponent(job) {
  const skills = unique([...(job.extracted_skills || []), ...(job.preferred_requirements || [])]);
  if (!skills.length) return { score: rules.fit_weights.skills / 2, matched: [], gaps: ['Skills não publicadas.'], coverage: null };
  const matched = skills.filter(evidenceCovers);
  const gaps = skills.filter(item => !evidenceCovers(item));
  const score = Math.round((matched.length / skills.length) * rules.fit_weights.skills);
  return { score, matched, gaps, coverage: matched.length / skills.length };
}

function seniorityComponent(job) {
  const text = normalize([job.title, job.seniority].join(' '));
  const negative = matches(text, ['júnior', 'junior', 'assistente', 'estágio', 'intern']);
  if (negative.length) return { score: 2, matched: [], gaps: [`Senioridade ou nível indicado como ${negative.join(', ')}.`] };
  if (matches(text, ['gerente', 'manager', 'coordenador', 'coordinator', 'principal', 'head', 'lead', 'sênior', 'senior']).length) {
    return { score: 10, matched: matches(text, rules.target_roles.direct_management_signals), gaps: [] };
  }
  if (matches(text, ['pleno', 'mid-level']).length) return { score: 7, matched: ['pleno'], gaps: ['Confirmar escopo de liderança e autonomia.'] };
  return { score: 5, matched: [], gaps: ['Senioridade não publicada ou não identificada.'] };
}

function sectorComponent(job) {
  const text = jobText(job);
  const food = matches(text, rules.target_industries.food);
  const financial = matches(text, rules.target_industries.financial_services);
  const other = matches(text, rules.target_industries.other_relevant);
  if (food.length || financial.length) return { score: 10, matched: unique([...food, ...financial]), gaps: [] };
  if (other.length) return { score: 6, matched: unique(other), gaps: ['Setor é relevante/transferível, mas não está entre as três prioridades principais.'] };
  return { score: 5, matched: [], gaps: ['Setor não identificado com segurança.'] };
}

function remunerationComponent(job) {
  const salary = numberFromSalary(job.salary);
  if (!salary) return { score: rules.salary.unknown_score, matched: [], gaps: ['Remuneração não divulgada; confirmar antes da candidatura.'], unknown: true };
  if (salary.max < rules.salary.minimum) return { score: rules.salary.below_minimum_score, matched: [], gaps: ['Faixa publicada abaixo da pretensão mínima.'], unknown: false };
  if (salary.min >= rules.salary.target) return { score: rules.salary.at_or_above_target_score, matched: [`>= R$${rules.salary.target}/mês`], gaps: [], unknown: false };
  return { score: rules.salary.at_or_above_minimum_score, matched: [`Faixa atinge R$${rules.salary.minimum}/mês`], gaps: ['Atinge o mínimo, mas não o alvo de R$18.000/mês.'], unknown: false };
}

function locationComponent(job, remuneration) {
  const location = normalize(job.location);
  const title = normalize(job.title);
  if (location.includes(normalize(rules.location.primary_city))) return { score: rules.location.primary_score, matched: [rules.location.primary_city], gaps: [] };
  if (location.includes(normalize(rules.location.secondary_city))) {
    const superiorSignals = matches(title, rules.location.secondary_superiority_title_signals);
    const salary = numberFromSalary(job.salary);
    const salarySuperior = salary && salary.max >= rules.location.secondary_superiority_salary_threshold;
    if (superiorSignals.length || salarySuperior) {
      return { score: rules.location.secondary_max_score, matched: ['São Paulo com sinal de oportunidade superior'], gaps: [] };
    }
    return { score: rules.location.secondary_base_score, matched: ['São Paulo'], gaps: ['São Paulo só deve avançar se superar claramente a posição atual.'] };
  }
  if (location.includes('sp') || location.includes('sao paulo')) return { score: rules.location.other_sp_score, matched: [job.location], gaps: ['Localidade paulista fora dos dois mercados principais.'] };
  if (!location) return { score: rules.location.unknown_score, matched: [], gaps: ['Localidade não publicada.'] };
  return { score: rules.location.unknown_score, matched: [job.location], gaps: ['Localidade fora do foco geográfico atual; revisar caso a caso.'] };
}

function companyComponent(job) {
  if (!job.company) return { score: 2, matched: [], gaps: ['Empresa não identificada.'] };
  return { score: 3, matched: [job.company], gaps: ['Não há preferência explícita de empresa configurada; componente neutro.'] };
}

function urgencyComponent(job) {
  const urgency = rules.urgency;
  let score = urgency.unknown_age_score;
  const age = Number(job.publication_age_days);
  if (Number.isFinite(age)) {
    if (age <= urgency.age_days_max_for_full_score) score = 100;
    else if (age >= urgency.age_days_for_zero_score) score = 0;
    else score = Math.round(100 - ((age - urgency.age_days_max_for_full_score) / (urgency.age_days_for_zero_score - urgency.age_days_max_for_full_score)) * 100);
  }
  const flags = [];
  if (Number(job.candidate_count) >= urgency.candidate_volume_high_threshold) {
    score -= urgency.candidate_volume_high_penalty;
    flags.push('volume de candidatos elevado');
  }
  if (Number.isFinite(Number(job.deadline_days_remaining)) && Number(job.deadline_days_remaining) <= urgency.deadline_near_days) {
    score += urgency.deadline_near_bonus;
    flags.push('prazo próximo');
  }
  return { score: clamp(Math.round(score), 0, 100), flags };
}

function selectCv(job) {
  const text = jobText(job);
  const foodHits = matches(text, rules.target_industries.food);
  const financialHits = matches(text, rules.target_industries.financial_services);
  const title = normalize(job.title);
  const managementTitle = matches(title, rules.target_roles.direct_management_signals).length > 0;
  if (foodHits.length >= 2 && !financialHits.some(hit => ['banco', 'bank', 'banking', 'servicos financeiros', 'financial services', 'pagamentos', 'payments', 'credito', 'credit', 'seguros', 'insurance', 'investimentos', 'investments'].includes(normalize(hit)))) {
    return 'food_industry_business';
  }
  if (financialHits.length >= 2 && !managementTitle) return 'financial_services_banking';
  if (managementTitle && matches(text, ['operações', 'operations', 'planejamento', 'planning', 'melhoria contínua', 'continuous improvement']).length) return 'management_coordination';
  const candidates = rules.cv_selection.map(option => ({
    cv_version: option.cv_version,
    hits: matches(text, option.when),
    priority: option.priority
  }));
  candidates.sort((a, b) => (b.hits.length - a.hits.length) || (a.priority - b.priority));
  return candidates[0]?.hits.length ? candidates[0].cv_version : 'business_consulting';
}

function bandFor(score) {
  return rules.fit_bands.find(band => score >= band.minimum && score <= band.maximum) || rules.fit_bands.at(-1);
}

function scoreJob(job) {
  const components = {
    function: functionComponent(job),
    required_experience: experienceComponent(job),
    skills: skillsComponent(job),
    seniority: seniorityComponent(job),
    sector: sectorComponent(job),
    remuneration: remunerationComponent(job),
    company: companyComponent(job)
  };
  components.location = locationComponent(job, components.remuneration);
  const fitScore = Object.entries(components).reduce((total, [key, value]) => total + Math.min(value.score, rules.fit_weights[key]), 0);
  const urgency = urgencyComponent(job);
  const opportunityScore = Math.round(fitScore * 0.85 + urgency.score * 0.15);
  const gaps = unique(Object.values(components).flatMap(component => component.gaps || []));
  const matched = unique(Object.values(components).flatMap(component => component.matched || []));
  const salaryUnknown = components.remuneration.unknown === true;
  const salaryBelowMinimum = components.remuneration.unknown === false && components.remuneration.score === rules.salary.below_minimum_score;
  const band = bandFor(fitScore);
  return {
    ...job,
    scoring: {
      fit_score: fitScore,
      opportunity_score: opportunityScore,
      fit_band: band.label,
      recommendation: salaryBelowMinimum ? 'BLOCKED_BY_SALARY' : band.default_action,
      components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, value.score])),
      matched_signals: matched,
      gaps,
      urgency_score: urgency.score,
      urgency_flags: urgency.flags,
      confidence: salaryUnknown ? 'MEDIUM - salary unknown' : 'MEDIUM-HIGH',
      salary_confirmation_required: salaryUnknown,
      application_eligibility: salaryBelowMinimum ? 'BLOCKED_BY_SALARY' : (salaryUnknown ? 'REVIEW_REQUIRED' : 'ELIGIBLE_FOR_REVIEW'),
      suggested_cv: selectCv(job),
      generated_at: new Date().toISOString()
    }
  };
}

function parseArgs(argv) {
  const args = { input: 'jobs/phase1_real_jobs.json', output: 'jobs/phase1_scored_jobs.json' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--input') args.input = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const input = readJson(args.input);
const scored = {
  schema_version: '0.1.0',
  scoring_rules_version: rules.schema_version,
  scored_at: new Date().toISOString(),
  jobs: input.jobs.map(scoreJob).sort((a, b) => b.scoring.opportunity_score - a.scoring.opportunity_score)
};
const outputPath = path.join(root, args.output);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(scored, null, 2)}\n`);
console.log(JSON.stringify({ output: args.output, jobs_scored: scored.jobs.length, top_jobs: scored.jobs.slice(0, 5).map(job => ({ job_id: job.job_id, title: job.title, company: job.company, fit_score: job.scoring.fit_score, opportunity_score: job.scoring.opportunity_score, suggested_cv: job.scoring.suggested_cv })) }, null, 2));
