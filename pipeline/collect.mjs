#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapLimit, nowIso, unique } from "./lib/util.mjs";
import { dedupe } from "./lib/normalize.mjs";
import { scoreJob, applyQuotas } from "./lib/score.mjs";
import { aiAvailable, rankBatch, estimateCost } from "./lib/ai.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (rel, fallback = null) => {
  try { return JSON.parse(await fs.readFile(path.join(ROOT, rel), "utf8")); }
  catch { return fallback; }
};
const writeJson = async (rel, value) => {
  const target = path.join(ROOT, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(value, null, 2) + "\n", "utf8");
};

function parseArgs(argv) {
  const args = { flags: new Set(), values: {} };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const [key, inline] = token.slice(2).split("=");
    if (inline !== undefined) args.values[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) { args.values[key] = argv[i + 1]; i += 1; }
    else args.flags.add(key);
  }
  return args;
}

const args = parseArgs(process.argv);
const DRY_RUN = args.flags.has("dry-run");
const NO_AI = args.flags.has("no-ai") || process.env.DISABLE_AI === "1";
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

async function main() {
  const started = Date.now();
  const profileCv = await readJson("config/profile.json", {});
  const searchConfig = await readJson("config/search-profiles.json");
  const sourcesConfig = await readJson("config/sources.json");
  if (!searchConfig || !sourcesConfig) throw new Error("config/search-profiles.json ou config/sources.json ausente");

  const profileId = args.values.profile || process.env.SEARCH_PROFILE || searchConfig.active_profile;
  const searchProfile = searchConfig.profiles.find((p) => p.id === profileId) || searchConfig.profiles[0];
  if (!searchProfile) throw new Error(`perfil de busca "${profileId}" nao encontrado`);

  // Termos extras vindos da interface (workflow_dispatch input "extra_queries").
  const extraQueries = (args.values["extra-queries"] || process.env.EXTRA_QUERIES || "")
    .split(/[;,\n]/).map((s) => s.trim()).filter(Boolean);
  if (extraQueries.length) {
    searchProfile.queries = unique([...extraQueries, ...(searchProfile.queries || [])]);
    log(`termos extras da busca sob demanda: ${extraQueries.join(" | ")}`);
  }

  const fx = searchConfig.fx_to_brl || { BRL: 1 };
  log(`perfil de busca: ${searchProfile.label} (${searchProfile.id})`);

  // ---------- 1. Coleta ----------
  const enabledSources = (sourcesConfig.sources || []).filter((s) => s.enabled !== false);
  const sourceReport = [];
  const collected = await mapLimit(enabledSources, 4, async (source) => {
    const missing = (source.requires_secret || []).filter((name) => !process.env[name]);
    if (missing.length) {
      sourceReport.push({ id: source.id, label: source.label, status: "PULADA", jobs: 0, detail: `secrets ausentes: ${missing.join(", ")}` });
      return [];
    }
    const startedAt = Date.now();
    try {
      const mod = await import(`./sources/${source.module}`);
      const jobs = await mod.collect({ options: source.options || {}, profile: searchProfile, log });
      sourceReport.push({ id: source.id, label: source.label, status: "OK", jobs: jobs.length, ms: Date.now() - startedAt });
      return jobs;
    } catch (error) {
      sourceReport.push({ id: source.id, label: source.label, status: "ERRO", jobs: 0, detail: String(error.message || error), ms: Date.now() - startedAt });
      log(`  ! fonte ${source.id} falhou: ${error.message}`);
      return [];
    }
  });

  const rawJobs = collected.flatMap((r) => (r.ok ? r.value : []));
  log(`coleta bruta: ${rawJobs.length} vagas de ${enabledSources.length} fonte(s)`);

  // ---------- 2. Dedup ----------
  const uniqueJobs = dedupe(rawJobs).filter((j) => j.title && j.url);
  log(`apos dedup: ${uniqueJobs.length} vagas unicas`);

  // ---------- 3. Decisoes ja tomadas ----------
  const decisions = await readJson("data/decisions.json", { decisions: {} });
  const terminal = ["applied", "rejected", "closed", "invalid_link"];
  const decidedIds = new Set(
    Object.entries(decisions.decisions || {}).filter(([, d]) => terminal.includes(d.status)).map(([id]) => id)
  );
  const decidedUrls = new Set(
    Object.values(decisions.decisions || {})
      .filter((d) => terminal.includes(d.status) && d.url)
      .map((d) => String(d.url).split("?")[0])
  );

  // ---------- 4. Score deterministico ----------
  const blockedReasons = {};
  const scored = [];
  for (const job of uniqueJobs) {
    if (searchProfile.filters?.hide_decided !== false && (decidedIds.has(job.id) || decidedUrls.has(job.url.split("?")[0]))) {
      blockedReasons.JA_DECIDIDA = (blockedReasons.JA_DECIDIDA || 0) + 1;
      continue;
    }
    const result = scoreJob(job, searchProfile, { fx });
    if (result.blocked) {
      const key = result.block_reason.split(":")[0];
      blockedReasons[key] = (blockedReasons[key] || 0) + 1;
      continue;
    }
    scored.push({ ...job, score: { ...result, rules: result.score, ai: null, final: result.score } });
  }
  scored.sort((a, b) => b.score.rules - a.score.rules);
  log(`aprovadas nos filtros: ${scored.length} | descartadas: ${JSON.stringify(blockedReasons)}`);

  // ---------- 5. Re-rank semantico com Claude ----------
  const aiCfg = searchProfile.ai_ranking || {};
  const aiUsage = { input_tokens: 0, output_tokens: 0, calls: 0, errors: [] };
  const aiOn = aiCfg.enabled !== false && !NO_AI && !DRY_RUN && aiAvailable();
  if (aiOn && scored.length) {
    const candidates = scored.slice(0, aiCfg.candidates_sent_to_ai || 60);
    const batchSize = aiCfg.batch_size || 12;
    const batches = [];
    for (let i = 0; i < candidates.length; i += batchSize) batches.push(candidates.slice(i, i + batchSize));
    log(`IA: avaliando ${candidates.length} vagas em ${batches.length} lote(s) com ${aiCfg.model}`);

    const results = await mapLimit(batches, 2, async (batch) => rankBatch({
      jobs: batch,
      profile: profileCv,
      searchProfile,
      model: aiCfg.model,
      maxDescriptionChars: aiCfg.max_description_chars || 4000
    }));

    const blend = aiCfg.blend || { rules: 0.35, ai: 0.65 };
    const byId = new Map(candidates.map((j) => [j.id, j]));
    for (const result of results) {
      if (!result.ok) { aiUsage.errors.push(String(result.error.message || result.error)); continue; }
      aiUsage.calls += 1;
      aiUsage.input_tokens += result.value.usage?.input_tokens || 0;
      aiUsage.output_tokens += result.value.usage?.output_tokens || 0;
      for (const [jobId, verdict] of result.value.map.entries()) {
        const job = byId.get(jobId);
        if (!job) continue;
        const aiScore = Math.max(0, Math.min(100, Number(verdict.ai_score) || 0));
        job.score.ai = aiScore;
        job.score.final = Math.round(job.score.rules * blend.rules + aiScore * blend.ai);
        job.ai = {
          verdict: verdict.verdict || "",
          why_fits: Array.isArray(verdict.why_fits) ? verdict.why_fits : [],
          gaps: Array.isArray(verdict.gaps) ? verdict.gaps : [],
          ats_missing: Array.isArray(verdict.ats_missing) ? verdict.ats_missing : [],
          cv_variant: verdict.cv_variant || "",
          risk: verdict.risk || ""
        };
      }
    }
    if (aiUsage.errors.length) log(`  ! IA: ${aiUsage.errors.length} lote(s) falharam; essas vagas ficam so com o score de regras`);
    const cost = estimateCost({
      model: aiCfg.model,
      inputTokens: aiUsage.input_tokens,
      outputTokens: aiUsage.output_tokens,
      pricing: searchConfig.ai_pricing_usd_per_mtok || {}
    });
    if (cost != null) {
      aiUsage.estimated_cost_usd = Number(cost.toFixed(4));
      log(`IA: ${aiUsage.input_tokens} tokens de entrada, ${aiUsage.output_tokens} de saida — custo estimado US$ ${cost.toFixed(4)}`);
    }
  } else if (!aiAvailable() && !DRY_RUN) {
    log("IA desligada: ANTHROPIC_API_KEY ausente. O feed usa apenas o score deterministico.");
  }

  // ---------- 6. Corte final e cotas ----------
  const minScore = searchProfile.filters?.min_final_score_to_show ?? 60;
  const eligible = scored.filter((j) => j.score.final >= minScore);
  const { selected, mix, targets } = applyQuotas(eligible, searchProfile);
  log(`feed final: ${selected.length} vagas | mix por regiao: ${JSON.stringify(mix)}`);

  // ---------- 7. Saida ----------
  const run = {
    run_id: `run_${Date.now()}`,
    finished_at: nowIso(),
    duration_ms: Date.now() - started,
    search_profile: searchProfile.id,
    extra_queries: extraQueries,
    counts: {
      raw: rawJobs.length,
      unique: uniqueJobs.length,
      passed_filters: scored.length,
      eligible: eligible.length,
      published: selected.length
    },
    blocked_reasons: blockedReasons,
    sources: sourceReport.sort((a, b) => b.jobs - a.jobs),
    ai: { enabled: aiOn, model: aiCfg.model, ...aiUsage },
    mix,
    quota_targets: targets
  };

  if (DRY_RUN) {
    console.log("\n--- DRY RUN, nada foi gravado ---");
    console.log(JSON.stringify(run, null, 2));
    console.log("\nTop 10:");
    for (const job of selected.slice(0, 10)) {
      console.log(`  ${String(job.score.final).padStart(3)} | ${job.title} @ ${job.company} (${job.location_raw || job.work_model}) [${job.source}]`);
    }
    return;
  }

  const feed = {
    schema_version: "3.0.0",
    generated_at: nowIso(),
    search_profile: { id: searchProfile.id, label: searchProfile.label },
    run_id: run.run_id,
    mix,
    jobs: selected.map((job) => ({
      id: job.id,
      title: job.title,
      company: job.company,
      location: job.location_raw,
      location_bucket: job.score.location_bucket,
      location_label: job.score.location_label,
      work_model: job.work_model,
      employment_type: job.employment_type,
      salary_brl_monthly: job.score.salary_brl_monthly ?? null,
      salary_raw: job.salary,
      posted_at: job.posted_at,
      age_days: job.age_days,
      url: job.url,
      source: job.source,
      also_seen_in: job.also_seen_in || [],
      score: { rules: job.score.rules, ai: job.score.ai, final: job.score.final, components: job.score.components },
      why_fits: unique([...(job.ai?.why_fits || []), ...job.score.reasons]).slice(0, 5),
      gaps: unique([...(job.ai?.gaps || []), ...job.score.flags]).slice(0, 5),
      ats_missing: job.ai?.ats_missing || [],
      verdict: job.ai?.verdict || "",
      risk: job.ai?.risk || "",
      cv_variant: job.ai?.cv_variant || "",
      description_excerpt: (job.description || "").slice(0, 1200)
    }))
  };

  await writeJson("data/feed.json", feed);
  await writeJson("data/last-run.json", run);

  const history = await readJson("data/runs.json", { runs: [] });
  history.runs = [run, ...(history.runs || [])].slice(0, 40);
  await writeJson("data/runs.json", history);

  // Guarda as descricoes completas para o gerador de CV e carta.
  const descriptions = Object.fromEntries(selected.map((j) => [j.id, {
    title: j.title, company: j.company, location_raw: j.location_raw,
    work_model: j.work_model, url: j.url, description: j.description
  }]));
  await writeJson("data/descriptions.json", descriptions);

  log(`gravado: data/feed.json (${feed.jobs.length} vagas)`);
}

main().catch((error) => {
  console.error("\nFALHA NA RODADA:", error.message);
  console.error(error.stack);
  process.exit(1);
});
