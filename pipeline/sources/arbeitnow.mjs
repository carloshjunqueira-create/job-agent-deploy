import { httpJson, norm } from "../lib/util.mjs";
import { toCanonicalJob } from "../lib/normalize.mjs";

export const id = "arbeitnow";

/** Arbeitnow: board publico (foco Europa/Alemanha), sem chave, paginado. */
export async function collect({ options = {}, profile, log }) {
  const maxPages = options.max_pages || 3;
  const terms = [...(profile.queries_international || []), ...(profile.must_have_any || [])].map(norm);
  const jobs = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const data = await httpJson(`https://www.arbeitnow.com/api/job-board-api?page=${page}`);
    const rows = data?.data || [];
    for (const r of rows) {
      const hay = norm(`${r.title} ${(r.tags || []).join(" ")}`);
      if (terms.length && !terms.some((t) => t.length > 3 && hay.includes(t))) continue;
      jobs.push(toCanonicalJob({
        title: r.title,
        company: r.company_name,
        location_raw: r.location || (r.remote ? "Remote" : ""),
        work_model_raw: r.remote ? "remote" : "",
        description: r.description,
        url: r.url,
        source_job_id: r.slug,
        posted_at: r.created_at ? new Date(r.created_at * 1000).toISOString() : null,
        employment_type: (r.job_types || []).join(", ")
      }, "arbeitnow"));
    }
    if (!rows.length) break;
  }
  log?.(`arbeitnow: ${jobs.length} vagas apos filtro de termo`);
  return jobs;
}
