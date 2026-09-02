import { httpJson, norm } from "../lib/util.mjs";
import { toCanonicalJob } from "../lib/normalize.mjs";

export const id = "remotive";

/**
 * Remotive: vagas remotas internacionais, sem chave.
 * Consultamos termo a termo pelo parametro `search` da propria API, em vez de
 * baixar o catalogo inteiro e filtrar aqui — o catalogo e dominado por vagas de
 * engenharia e o filtro local voltava vazio.
 */
export async function collect({ options = {}, profile, log }) {
  const limit = options.limit || 50;
  const queries = [...(profile.queries_international || []), ...(profile.queries || [])].slice(0, options.max_queries || 6);
  const seen = new Set();
  const jobs = [];

  for (const query of queries) {
    const params = new URLSearchParams({ search: query, limit: String(limit) });
    const data = await httpJson(`https://remotive.com/api/remote-jobs?${params.toString()}`);
    for (const r of data?.jobs || []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      jobs.push(toCanonicalJob({
        title: r.title,
        company: r.company_name,
        location_raw: r.candidate_required_location || "Remote",
        work_model_raw: "remote",
        description: r.description,
        url: r.url,
        source_job_id: r.id,
        posted_at: r.publication_date,
        employment_type: r.job_type || ""
      }, "remotive"));
    }
  }
  log?.(`remotive: ${jobs.length} vagas em ${queries.length} consulta(s)`);
  return jobs;
}
