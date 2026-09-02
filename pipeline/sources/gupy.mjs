import { httpJson, norm } from "../lib/util.mjs";
import { toCanonicalJob } from "../lib/normalize.mjs";

export const id = "gupy";

/**
 * Gupy: endpoint publico do portal de vagas, nao documentado pela Gupy.
 *
 * Consultamos apenas por cargo, sem filtro de cidade. Filtrar por cidade na API
 * exigia acertar a grafia acentuada exata ("Sao Jose" nao casa com "São José") e
 * era o motivo de a fonte voltar zero vagas. A cidade e resolvida depois, pelo
 * classificador de localizacao, que ja normaliza acentos.
 */
export async function collect({ options = {}, profile, log }) {
  const limit = Math.min(options.limit || 100, 100);
  const maxQueries = options.max_queries || 8;
  const jobs = [];
  const shapes = new Set();

  for (const query of (profile.queries || []).slice(0, maxQueries)) {
    const params = new URLSearchParams({ name: query, offset: "0", limit: String(limit) });
    let data = null;
    try {
      data = await httpJson(`https://portal.api.gupy.io/api/job?${params.toString()}`);
    } catch {
      data = await httpJson(`https://employability-portal.gupy.io/api/v1/jobs?${new URLSearchParams({ jobName: query, limit: String(limit) })}`);
    }
    const rows = data?.data || data?.jobs || data?.results || [];
    // Se a resposta veio sem vagas, guardamos o formato para o diagnostico dizer
    // o que a Gupy devolveu, em vez de so "0 vagas".
    if (!rows.length && data && typeof data === "object") {
      shapes.add(Object.keys(data).slice(0, 8).join(","));
    }
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

  if (!jobs.length && shapes.size) {
    log?.(`gupy: 0 vagas. A API respondeu, mas com este formato: {${Array.from(shapes).join(" | ")}}`);
  } else {
    log?.(`gupy: ${jobs.length} vagas brutas`);
  }
  return jobs;
}
