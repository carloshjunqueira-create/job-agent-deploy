import { httpJson, norm } from "../lib/util.mjs";
import { toCanonicalJob } from "../lib/normalize.mjs";

export const id = "gupy";

/**
 * Gupy: usa o endpoint publico do portal de vagas. Nao e documentado pela Gupy,
 * entao o conector e best-effort: se o formato mudar, ele falha sozinho e a rodada continua.
 */
export async function collect({ options = {}, profile, log }) {
  const limit = options.limit || 60;
  const cities = (profile.locations || [])
    .filter((l) => l.enabled !== false && l.kind === "city")
    .map((l) => l.label.split(",")[0]);

  const jobs = [];
  for (const query of (profile.queries || []).slice(0, 8)) {
    for (const city of cities) {
      const params = new URLSearchParams({ name: query, city, offset: "0", limit: String(limit) });
      let data = null;
      try {
        data = await httpJson(`https://portal.api.gupy.io/api/job?${params.toString()}`);
      } catch {
        data = await httpJson(`https://employability-portal.gupy.io/api/v1/jobs?${new URLSearchParams({ jobName: query, city, limit: String(limit) })}`);
      }
      const rows = data?.data || data?.jobs || [];
      for (const r of rows) {
        const locationRaw = [r.city, r.state].filter(Boolean).join(", ") || r.workplaceAddress || "";
        jobs.push(toCanonicalJob({
          title: r.name || r.title,
          company: r.careerPageName || r.companyName || r.company,
          location_raw: locationRaw,
          country: "br",
          work_model_raw: norm(r.workplaceType || r.type || ""),
          description: r.description || r.jobDescription || "",
          url: r.jobUrl || r.careerPageUrl || r.applicationUrl,
          source_job_id: r.id,
          posted_at: r.publishedDate || r.createdAt,
          employment_type: r.type || ""
        }, "gupy"));
      }
    }
  }
  log?.(`gupy: ${jobs.length} vagas brutas`);
  return jobs;
}
