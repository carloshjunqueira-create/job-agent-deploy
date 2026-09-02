#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (rel) => JSON.parse(await fs.readFile(path.join(ROOT, rel), "utf8"));

const searchConfig = await readJson("config/search-profiles.json");
const sourcesConfig = await readJson("config/sources.json");
const searchProfile = searchConfig.profiles.find((p) => p.id === searchConfig.active_profile) || searchConfig.profiles[0];

// Perfil reduzido: uma consulta por fonte, so para provar que o endpoint responde.
const probe = {
  ...searchProfile,
  queries: (searchProfile.queries || []).slice(0, 1),
  queries_international: (searchProfile.queries_international || []).slice(0, 1),
  locations: (searchProfile.locations || []).filter((l) => l.enabled !== false).slice(0, 1)
};

console.log("Diagnostico de fontes");
console.log("=====================");
let ok = 0;
let failed = 0;
for (const source of sourcesConfig.sources || []) {
  if (source.enabled === false) { console.log(`- ${source.label}: DESLIGADA na config`); continue; }
  const missing = (source.requires_secret || []).filter((n) => !process.env[n]);
  if (missing.length) { console.log(`- ${source.label}: PULADA (faltam secrets: ${missing.join(", ")})`); continue; }
  const started = Date.now();
  try {
    const mod = await import(`./sources/${source.module}`);
    const jobs = await mod.collect({
      options: { ...(source.options || {}), max_pages: 1, pages: 1, limit: 25 },
      profile: probe,
      log: () => {}
    });
    console.log(`- ${source.label}: OK -> ${jobs.length} vagas em ${Date.now() - started}ms`);
    if (jobs[0]) console.log(`    exemplo: "${jobs[0].title}" @ ${jobs[0].company} (${jobs[0].location_raw || jobs[0].work_model})`);
    ok += 1;
  } catch (error) {
    console.log(`- ${source.label}: ERRO -> ${error.message}`);
    failed += 1;
  }
}
console.log(`\nResumo: ${ok} fonte(s) respondendo, ${failed} com erro.`);
