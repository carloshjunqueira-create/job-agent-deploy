import { httpJson, norm } from "../lib/util.mjs";
import { toCanonicalJob } from "../lib/normalize.mjs";

export const id = "arbeitnow";

const roleTerms = (profile) => [
  ...(profile.queries_international || []),
  ...(profile.queries || [])
].map(norm).filter((t) => t.length > 5);


/**
 * Arbeitnow: board publico com forte presenca na Europa, sem chave.
 * So aproveitamos as vagas marcadas como remotas: as presenciais em Berlim ou
 * Munique nao cabem em nenhuma regiao configurada e viravam ruido puro.
 */
export async function collect({ options = {}, profile, log }) {
  const maxPages = options.max_pages || 3;
  const terms = roleTerms(profile);
  const jobs = [];
  let scanned = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const data = await httpJson(`https://www.arbeitnow.com/api/job-board-api?page=${page}`);
    const rows = data?.data || [];
    scanned += rows.length;
    for (const r of rows) {
      // A flag `remote` da Arbeitnow e pouco preenchida; aceitamos tambem quando
      // titulo ou local dizem remoto.
      const saysRemote = Boolean(r.remote) || /remote|remotiv|home\s?office/i.test(`${r.title} ${r.location || ""}`);
      if (options.remote_only !== false && !saysRemote) continue;
      const hay = norm(`${r.title} ${(r.tags || []).join(" ")}`);
      if (terms.length && !terms.some((t) => t.length > 3 && hay.includes(t))) continue;
      jobs.push(toCanonicalJob({
        title: r.title,
        company: r.company_name,
        location_raw: r.location || "Remote",
        work_model_raw: "remote",
        description: r.description,
        url: r.url,
        source_job_id: r.slug,
        posted_at: r.created_at ? new Date(r.created_at * 1000).toISOString() : null,
        employment_type: (r.job_types || []).join(", ")
      }, "arbeitnow"));
    }
    if (!rows.length) break;
  }
  log?.(`arbeitnow: ${jobs.length} vagas remotas de ${scanned} anuncios lidos`);
  return jobs;
}
