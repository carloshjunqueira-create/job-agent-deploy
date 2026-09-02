import { httpJson, norm } from "../lib/util.mjs";
import { toCanonicalJob } from "../lib/normalize.mjs";

export const id = "himalayas";

/** Himalayas: API publica de vagas remotas internacionais. */
export async function collect({ options = {}, profile, log }) {
  const limit = options.limit || 100;
  const data = await httpJson(`https://himalayas.app/jobs/api?limit=${limit}`);
  const rows = data?.jobs || data?.data || [];
  const terms = [...(profile.queries_international || []), ...(profile.must_have_any || [])].map(norm);
  const jobs = [];
  for (const r of rows) {
    const hay = norm(`${r.title} ${(r.categories || []).join(" ")}`);
    if (terms.length && !terms.some((t) => t.length > 3 && hay.includes(t))) continue;
    jobs.push(toCanonicalJob({
      title: r.title,
      company: r.companyName || r.company,
      location_raw: (r.locationRestrictions || []).join(", ") || "Remote",
      work_model_raw: "remote",
      description: r.description || r.excerpt,
      url: r.applicationLink || r.guid,
      source_job_id: r.guid,
      posted_at: r.pubDate ? new Date(r.pubDate * 1000).toISOString() : null,
      salary: r.minSalary ? { min: r.minSalary, max: r.maxSalary ?? null, currency: r.salaryCurrency || "USD", period: "yearly", confidence: "source" } : null
    }, "himalayas"));
  }
  log?.(`himalayas: ${jobs.length} vagas apos filtro de termo`);
  return jobs;
}
