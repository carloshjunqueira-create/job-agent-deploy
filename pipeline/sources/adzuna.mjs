import { httpJson, norm } from "../lib/util.mjs";
import { toCanonicalJob } from "../lib/normalize.mjs";

export const id = "adzuna";

/**
 * Adzuna: agregador com cobertura no Brasil (br) e internacional (us, gb, ca...).
 * Requer app_id + app_key gratuitos em https://developer.adzuna.com/
 */
export async function collect({ options = {}, profile, log }) {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) throw new Error("ADZUNA_APP_ID / ADZUNA_APP_KEY ausentes");

  const countries = Array.isArray(options.country) ? options.country : [options.country || "br"];
  const perPage = Math.min(options.results_per_page || 50, 50);
  const maxPages = options.max_pages || 1;
  const remoteOnly = Boolean(options.remote_only);

  const queries = remoteOnly
    ? (profile.queries_international || profile.queries || [])
    : (profile.queries || []);

  const wheres = remoteOnly
    ? [""]
    : (profile.locations || [])
        .filter((l) => l.enabled !== false && l.kind === "city" && l.adzuna_where)
        .map((l) => l.adzuna_where);

  const jobs = [];
  for (const country of countries) {
    for (const query of queries.slice(0, 10)) {
      for (const where of (wheres.length ? wheres : [""])) {
        for (let page = 1; page <= maxPages; page += 1) {
          const params = new URLSearchParams({
            app_id: appId,
            app_key: appKey,
            results_per_page: String(perPage),
            what_phrase: query,
            content_type: "application/json"
          });
          if (where) params.set("where", where);
          if (options.max_days_old) params.set("max_days_old", String(options.max_days_old));
          const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/${page}?${params.toString()}`;
          const data = await httpJson(url);
          const results = data?.results || [];
          for (const r of results) {
            const locationRaw = r.location?.display_name || "";
            if (remoteOnly) {
              const hay = norm(`${r.title} ${locationRaw} ${(r.description || "").slice(0, 800)}`);
              if (!/(remote|remoto|anywhere|work from home|home office)/.test(hay)) continue;
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
  log?.(`adzuna: ${jobs.length} vagas brutas de ${countries.join(",")}`);
  return jobs;
}
