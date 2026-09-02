import { httpJson, norm } from "../lib/util.mjs";
import { toCanonicalJob } from "../lib/normalize.mjs";

export const id = "remotive";

/** Remotive: API publica de vagas remotas internacionais, sem chave. */
export async function collect({ options = {}, profile, log }) {
  const limit = options.limit || 200;
  const terms = [...(profile.queries_international || []), ...(profile.must_have_any || [])].map(norm);
  const data = await httpJson(`https://remotive.com/api/remote-jobs?limit=${limit}`);
  const jobs = [];
  for (const r of data?.jobs || []) {
    const hay = norm(`${r.title} ${r.category}`);
    if (terms.length && !terms.some((t) => t.length > 3 && hay.includes(t))) continue;
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
  log?.(`remotive: ${jobs.length} vagas apos filtro de termo`);
  return jobs;
}
