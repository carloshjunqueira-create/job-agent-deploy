import { httpJson, norm } from "../lib/util.mjs";
import { toCanonicalJob } from "../lib/normalize.mjs";

export const id = "adzuna";

/**
 * Adzuna: agregador com cobertura no Brasil (br) e internacional (us, gb, ca...).
 * Requer app_id + app_key gratuitos em https://developer.adzuna.com/
 *
 * A API responde HTTP 400 para qualquer parametro que nao reconheca — foi o que
 * derrubou a versao anterior, que enviava "content_type" (com underscore) e
 * "what_phrase". Aqui so entram parametros documentados, e existe um fallback:
 * se a chamada completa levar 400, refazemos com o conjunto minimo.
 */

const buildUrl = (country, page, params) =>
  `https://api.adzuna.com/v1/api/jobs/${country}/search/${page}?${params.toString()}`;

async function fetchPage({ country, page, appId, appKey, query, where, perPage, maxDaysOld }) {
  const base = () => {
    const p = new URLSearchParams({ app_id: appId, app_key: appKey });
    p.set("what", query);
    if (where) p.set("where", where);
    return p;
  };

  const full = base();
  full.set("results_per_page", String(perPage));
  if (maxDaysOld) full.set("max_days_old", String(maxDaysOld));

  try {
    return await httpJson(buildUrl(country, page, full), { retries: 1 });
  } catch (error) {
    if (error.status !== 400) throw error;
    const data = await httpJson(buildUrl(country, page, base()), { retries: 1 });
    if (data) data.__usedFallback = true;
    return data;
  }
}

export async function collect({ options = {}, profile, log }) {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) throw new Error("ADZUNA_APP_ID / ADZUNA_APP_KEY ausentes");

  const countries = Array.isArray(options.country) ? options.country : [options.country || "br"];
  const perPage = Math.min(options.results_per_page || 50, 50);
  const maxPages = options.max_pages || 1;
  const remoteOnly = Boolean(options.remote_only);
  const maxDaysOld = options.max_days_old;

  const queries = remoteOnly
    ? (profile.queries_international || profile.queries || [])
    : (profile.queries || []);

  const wheres = remoteOnly
    ? [""]
    : (profile.locations || [])
        .filter((l) => l.enabled !== false && l.kind === "city")
        .map((l) => l.adzuna_where || l.label.split(",")[0]);

  const jobs = [];
  let usedFallback = false;

  for (const country of countries) {
    for (const query of queries.slice(0, options.max_queries || 8)) {
      for (const where of (wheres.length ? wheres : [""])) {
        for (let page = 1; page <= maxPages; page += 1) {
          const data = await fetchPage({ country, page, appId, appKey, query, where, perPage, maxDaysOld });
          if (data?.__usedFallback) usedFallback = true;
          const results = data?.results || [];
          for (const r of results) {
            const locationRaw = r.location?.display_name || "";
            if (remoteOnly) {
              // So titulo e local. A descricao menciona "remote" de passagem em
              // vagas presenciais e foi o que trouxe um franchise consultant
              // presencial em Phoenix para o balde de remoto internacional.
              const hay = norm(`${r.title} ${locationRaw}`);
              const strong = norm(r.description || "").slice(0, 1500);
              const ok = /(remote|remoto|anywhere|work from home|home office)/.test(hay)
                || /(fully remote|100% remote|remote-first|work from anywhere)/.test(strong);
              if (!ok) continue;
            }
            jobs.push(toCanonicalJob({
              title: r.title,
              company: r.company?.display_name,
              location_raw: locationRaw,
              country,
              description: r.description,
              url: r.redirect_url,
              source_job_id: r.id,
              posted_at: r.created,
              employment_type: r.contract_type || r.contract_time || "",
              salary: r.salary_min ? {
                min: r.salary_min,
                max: r.salary_max ?? null,
                currency: country === "br" ? "BRL" : (country === "gb" ? "GBP" : "USD"),
                period: "yearly",
                confidence: "source"
              } : null
            }, `adzuna_${country}`));
          }
          if (results.length < perPage) break;
        }
      }
    }
  }
  log?.(`adzuna: ${jobs.length} vagas brutas de ${countries.join(",")}${usedFallback ? " (a API recusou os opcionais; usei o conjunto minimo)" : ""}`);
  return jobs;
}
