import { norm, stripHtml, hashId, daysSince, unique } from "./util.mjs";

const REMOTE_TERMS = ["remoto", "remote", "home office", "teletrabalho", "anywhere", "work from home", "fully remote", "100% remoto", "telecommute", "distributed"];
const HYBRID_TERMS = ["hibrido", "hybrid"];
const ONSITE_TERMS = ["presencial", "on-site", "onsite", "no local"];

const BR_HINTS = ["brasil", "brazil", ", sp", ", rj", ", mg", ", pr", ", rs", ", sc", ", ba", ", pe", ", ce", ", go", ", df", "sao paulo", "rio de janeiro", "belo horizonte", "curitiba", "porto alegre"];

/** Detecta modelo de trabalho a partir de titulo, local e descricao. */
export function detectWorkModel(job) {
  const haystack = norm([job.title, job.location_raw, job.work_model_raw, (job.description || "").slice(0, 1500)].join(" "));
  if (REMOTE_TERMS.some((t) => haystack.includes(t))) {
    if (HYBRID_TERMS.some((t) => haystack.includes(t))) return "hybrid";
    return "remote";
  }
  if (HYBRID_TERMS.some((t) => haystack.includes(t))) return "hybrid";
  if (ONSITE_TERMS.some((t) => haystack.includes(t))) return "onsite";
  return "unknown";
}

export function looksBrazilian(job) {
  const haystack = norm([job.location_raw, job.country, job.company].join(" "));
  if (haystack.includes("brasil") || haystack.includes("brazil")) return true;
  return BR_HINTS.some((hint) => haystack.includes(hint));
}

/**
 * Classifica a vaga em um dos buckets configurados em search-profiles.locations.
 * Retorna o bucket ou null quando a vaga nao cabe em nenhum bucket habilitado.
 */
export function classifyLocation(job, profile) {
  const enabled = (profile.locations || []).filter((l) => l.enabled !== false);
  const haystack = norm([job.location_raw, job.city, job.state, job.country].join(" "));
  const workModel = job.work_model || "unknown";

  for (const bucket of enabled) {
    if (bucket.kind === "city") {
      if ((bucket.match || []).some((m) => haystack.includes(norm(m)))) return bucket;
    }
  }
  if (workModel === "remote") {
    const brazilian = looksBrazilian(job);
    const intl = enabled.find((b) => b.kind === "remote_international");
    const national = enabled.find((b) => b.kind === "remote_national");
    if (!brazilian && intl) return intl;
    if (brazilian && national) return national;
    return null;
  }
  return null;
}

const SALARY_RE = /(r\$|us\$|usd|eur|€|£|gbp)?\s*([\d]{1,3}(?:[.,\s]\d{3})+|\d{4,7})(?:\s*[-–a]{1,3}\s*([\d]{1,3}(?:[.,\s]\d{3})+|\d{4,7}))?/gi;

function toNumber(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/\s/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(/,(?=\d{3}\b)/g, "").replace(",", ".");
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Extrai salario do texto quando a fonte nao entrega campo estruturado. Conservador de proposito. */
export function parseSalaryFromText(text = "") {
  const source = norm(text);
  if (!source) return null;
  const hasSalaryWord = /(salario|salary|remuneracao|compensation|pacote|faixa salarial|pretensao)/.test(source);
  if (!hasSalaryWord) return null;
  SALARY_RE.lastIndex = 0;
  let match;
  while ((match = SALARY_RE.exec(source)) !== null) {
    const min = toNumber(match[2]);
    const max = toNumber(match[3]);
    if (min == null) continue;
    let currency = "BRL";
    const symbol = (match[1] || "").trim();
    if (symbol.includes("us") || symbol === "usd") currency = "USD";
    else if (symbol.includes("eur") || symbol === "€") currency = "EUR";
    else if (symbol.includes("gbp") || symbol === "£") currency = "GBP";
    const period = min > 40000 ? "yearly" : "monthly";
    if (min < 900) continue;
    return { min, max: max ?? null, currency, period, confidence: "text" };
  }
  return null;
}

export function monthlyBrl(salary, fx) {
  if (!salary || salary.min == null) return null;
  const rate = fx[salary.currency] ?? 1;
  const base = salary.min * rate;
  if (salary.period === "yearly") return Math.round(base / 12);
  if (salary.period === "hourly") return Math.round(base * 160);
  if (salary.period === "daily") return Math.round(base * 21);
  return Math.round(base);
}

/** Constroi o objeto canonico de vaga a partir do retorno bruto de um conector. */
export function toCanonicalJob(raw, sourceId) {
  const description = stripHtml(raw.description || "");
  const base = {
    title: String(raw.title || "").trim(),
    company: String(raw.company || "").trim() || "Nao informado",
    location_raw: String(raw.location_raw || "").trim(),
    city: raw.city || "",
    state: raw.state || "",
    country: raw.country || "",
    work_model_raw: raw.work_model_raw || "",
    description,
    url: raw.url || "",
    apply_url: raw.apply_url || raw.url || "",
    source: sourceId,
    source_job_id: raw.source_job_id ? String(raw.source_job_id) : "",
    posted_at: raw.posted_at || null,
    employment_type: raw.employment_type || "",
    salary: raw.salary || parseSalaryFromText(`${raw.title} ${description.slice(0, 1200)}`)
  };
  base.work_model = detectWorkModel(base);
  base.age_days = daysSince(base.posted_at);
  base.id = hashId(base.title, base.company, base.location_raw || base.city, base.url.split("?")[0]);
  base.collected_at = new Date().toISOString();
  return base;
}

/**
 * Dedup por titulo+empresa, com merge campo a campo.
 * Nunca troca um anuncio inteiro pelo outro: pega a descricao mais longa, mas preserva
 * salario, data e demais campos ja conhecidos — senao uma versao truncada do mesmo
 * anuncio apagaria o salario que a outra fonte publicou.
 */
export function dedupe(jobs) {
  const byKey = new Map();
  for (const job of jobs) {
    const key = hashId(job.title, job.company);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...job, also_seen_in: [job.source] });
      continue;
    }
    existing.also_seen_in = unique([...(existing.also_seen_in || []), job.source]);
    if ((job.description || "").length > (existing.description || "").length) {
      existing.description = job.description;
    }
    // Salario com confirmacao da fonte vale mais do que salario lido do texto.
    if (job.salary && (!existing.salary || (job.salary.confidence === "source" && existing.salary.confidence !== "source"))) {
      existing.salary = job.salary;
    }
    if (job.posted_at && (!existing.posted_at || new Date(job.posted_at) > new Date(existing.posted_at))) {
      existing.posted_at = job.posted_at;
      existing.age_days = daysSince(job.posted_at);
    }
    for (const field of ["location_raw", "city", "state", "country", "employment_type", "work_model_raw"]) {
      if (!existing[field] && job[field]) existing[field] = job[field];
    }
    if (existing.work_model === "unknown" && job.work_model !== "unknown") existing.work_model = job.work_model;
  }
  return Array.from(byKey.values());
}
