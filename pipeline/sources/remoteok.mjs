import { httpJson, norm } from "../lib/util.mjs";
import { toCanonicalJob } from "../lib/normalize.mjs";

export const id = "remoteok";

/** RemoteOK: feed JSON publico. O primeiro item do array e metadado legal e deve ser descartado. */
export async function collect({ profile, log }) {
  const data = await httpJson("https://remoteok.com/api");
  const rows = Array.isArray(data) ? data.slice(1) : [];
  const terms = [...(profile.queries_international || []), ...(profile.must_have_any || [])].map(norm);
  const jobs = [];
  for (const r of rows) {
    const hay = norm(`${r.position || r.title} ${(r.tags || []).join(" ")}`);
    if (terms.length && !terms.some((t) => t.length > 3 && hay.includes(t))) continue;
    jobs.push(toCanonicalJob({
      title: r.position || r.title,
      company: r.company,
      location_raw: r.location || "Remote",
      work_model_raw: "remote",
      description: r.description,
      url: r.url || r.apply_url,
      source_job_id: r.id,
      posted_at: r.date,
      salary: r.salary_min ? { min: r.salary_min, max: r.salary_max ?? null, currency: "USD", period: "yearly", confidence: "source" } : null
    }, "remoteok"));
  }
  log?.(`remoteok: ${jobs.length} vagas apos filtro de termo`);
  return jobs;
}
