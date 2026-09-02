import { httpJson } from "../lib/util.mjs";
import { toCanonicalJob } from "../lib/normalize.mjs";

export const id = "jooble";

/** Jooble: API gratuita mediante chave (https://br.jooble.org/api/about). POST com JSON. */
export async function collect({ options = {}, profile, log }) {
  const key = process.env.JOOBLE_API_KEY;
  if (!key) throw new Error("JOOBLE_API_KEY ausente");
  const host = options.host || "br.jooble.org";
  const pages = options.pages || 1;

  const cities = (profile.locations || [])
    .filter((l) => l.enabled !== false && l.kind === "city")
    .map((l) => l.label);

  const jobs = [];
  for (const query of (profile.queries || []).slice(0, options.max_queries || 8)) {
    for (const location of cities) {
      for (let page = 1; page <= pages; page += 1) {
        const data = await httpJson(`https://${host}/api/${key}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ keywords: query, location, page: String(page) })
        });
        const results = data?.jobs || [];
        for (const r of results) {
          jobs.push(toCanonicalJob({
            title: r.title,
            company: r.company,
            location_raw: r.location,
            country: "br",
            description: r.snippet,
            url: r.link,
            source_job_id: r.id,
            posted_at: r.updated,
            employment_type: r.type || ""
          }, "jooble"));
        }
        if (results.length === 0) break;
      }
    }
  }
  log?.(`jooble: ${jobs.length} vagas brutas`);
  return jobs;
}
