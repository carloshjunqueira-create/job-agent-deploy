import { httpJson, norm } from "../lib/util.mjs";
import { toCanonicalJob } from "../lib/normalize.mjs";

export const id = "ats";

const roleTerms = (profile) => [
  ...(profile.queries_international || []),
  ...(profile.queries || [])
].map(norm).filter((t) => t.length > 5);


/**
 * Paginas de carreira publicas: Greenhouse, Lever e Ashby.
 * Cobre vagas que muitas vezes nao chegam a agregadores. Configure os slugs em config/sources.json.
 */
export async function collect({ options = {}, profile, log }) {
  const jobs = [];
  const terms = roleTerms(profile);
  const matches = (title) => !terms.length || terms.some((t) => norm(title).includes(t));

  for (const slug of options.greenhouse || []) {
    const data = await httpJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
    for (const r of data?.jobs || []) {
      if (!matches(r.title)) continue;
      jobs.push(toCanonicalJob({
        title: r.title,
        company: slug,
        location_raw: r.location?.name || "",
        description: r.content,
        url: r.absolute_url,
        source_job_id: r.id,
        posted_at: r.updated_at
      }, `greenhouse:${slug}`));
    }
  }

  for (const slug of options.lever || []) {
    const rows = await httpJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    for (const r of rows || []) {
      if (!matches(r.text)) continue;
      jobs.push(toCanonicalJob({
        title: r.text,
        company: slug,
        location_raw: r.categories?.location || "",
        work_model_raw: r.workplaceType || "",
        description: r.descriptionPlain || r.description,
        url: r.hostedUrl,
        source_job_id: r.id,
        posted_at: r.createdAt ? new Date(r.createdAt).toISOString() : null,
        employment_type: r.categories?.commitment || ""
      }, `lever:${slug}`));
    }
  }

  for (const slug of options.ashby || []) {
    const data = await httpJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
    for (const r of data?.jobs || []) {
      if (!matches(r.title)) continue;
      jobs.push(toCanonicalJob({
        title: r.title,
        company: data.name || slug,
        location_raw: r.location || "",
        work_model_raw: r.isRemote ? "remote" : "",
        description: r.descriptionPlain || r.descriptionHtml,
        url: r.jobUrl || r.applyUrl,
        source_job_id: r.id,
        posted_at: r.publishedAt
      }, `ashby:${slug}`));
    }
  }

  log?.(`ats: ${jobs.length} vagas de paginas de carreira`);
  return jobs;
}
