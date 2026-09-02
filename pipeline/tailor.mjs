#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nowIso } from "./lib/util.mjs";
import { tailorForJob, aiAvailable, estimateCost } from "./lib/ai.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (rel, fallback = null) => {
  try { return JSON.parse(await fs.readFile(path.join(ROOT, rel), "utf8")); } catch { return fallback; }
};

const jobId = process.argv[2] || process.env.JOB_ID;
// "cv" gera so o curriculo adaptado; qualquer outra coisa gera CV + carta.
const mode = (process.argv[3] || process.env.TAILOR_MODE || "full").toLowerCase();
const includeCoverLetter = mode !== "cv" && mode !== "cv-only" && mode !== "so-cv";
if (!jobId) {
  console.error("uso: node pipeline/tailor.mjs <job_id>   (ou JOB_ID=<id>)");
  process.exit(1);
}
if (!aiAvailable()) {
  console.error("ANTHROPIC_API_KEY nao configurada: o gerador de CV e carta precisa dela.");
  process.exit(1);
}

const profile = await readJson("config/profile.json", {});
const searchConfig = await readJson("config/search-profiles.json", {});
const searchProfile = (searchConfig.profiles || []).find((p) => p.id === searchConfig.active_profile) || (searchConfig.profiles || [])[0] || {};
const descriptions = await readJson("data/descriptions.json", {});
const feed = await readJson("data/feed.json", { jobs: [] });

const job = descriptions[jobId] || feed.jobs.find((j) => j.id === jobId);
// A regiao vem do feed e define qual cabecalho de localidade entra no CV.
const feedEntry = feed.jobs.find((j) => j.id === jobId);
const region = feedEntry?.location_bucket
  || ((job?.work_model === "remote") ? "remote" : "default");
if (!job) {
  console.error(`vaga ${jobId} nao encontrada em data/descriptions.json nem no feed atual.`);
  process.exit(1);
}

const model = searchProfile.ai_tailoring?.model || searchProfile.ai_ranking?.model || "claude-sonnet-5";
console.log(`gerando ${includeCoverLetter ? "CV adaptado e carta" : "apenas o CV adaptado"} para: ${job.title} @ ${job.company}`);

const { result, usage } = await tailorForJob({
  job: {
    title: job.title,
    company: job.company,
    location_raw: job.location_raw || job.location || "",
    work_model: job.work_model || "",
    url: job.url || "",
    description: job.description || job.description_excerpt || ""
  },
  profile,
  model,
  includeCoverLetter,
  region
});

const cost = estimateCost({
  model,
  inputTokens: usage?.input_tokens || 0,
  outputTokens: usage?.output_tokens || 0,
  pricing: searchConfig.ai_pricing_usd_per_mtok || {}
});
if (cost != null) console.log(`custo estimado desta geracao: US$ ${cost.toFixed(4)}`);

const output = {
  job_id: jobId,
  job: { title: job.title, company: job.company, url: job.url },
  generated_at: nowIso(),
  model,
  mode: includeCoverLetter ? "cv+carta" : "so-cv",
  region,
  usage,
  estimated_cost_usd: cost != null ? Number(cost.toFixed(4)) : null,
  ...result
};

const target = path.join(ROOT, "data", "tailored", `${jobId}.json`);
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.writeFile(target, JSON.stringify(output, null, 2) + "\n", "utf8");

const index = await readJson("data/tailored/index.json", { items: {} });
index.items[jobId] = { title: job.title, company: job.company, generated_at: output.generated_at };
await fs.writeFile(path.join(ROOT, "data", "tailored", "index.json"), JSON.stringify(index, null, 2) + "\n", "utf8");

console.log(`gravado: data/tailored/${jobId}.json`);
