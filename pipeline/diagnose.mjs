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

// ---------- Teste de conexao com a API da Anthropic ----------
// Uma chamada minima (poucos tokens, custo desprezivel) so para provar que a
// chave e o workspace estao corretos, sem precisar rodar uma busca inteira.
console.log("\nConexao com a IA");
console.log("================");
const { aiAvailable, callClaude } = await import("./lib/ai.mjs");
if (!aiAvailable()) {
  console.log("- ANTHROPIC_API_KEY nao configurada: o feed sai sem avaliacao da IA.");
} else {
  const model = searchProfile.ai_ranking?.model || "claude-sonnet-5";
  const temWorkspace = Boolean(process.env.ANTHROPIC_WORKSPACE_ID);
  console.log(`- modelo: ${model}`);
  console.log(`- ANTHROPIC_WORKSPACE_ID: ${temWorkspace ? "configurado" : "NAO configurado"}`);
  try {
    const r = await callClaude({ model, system: "Responda apenas: ok", prompt: "ok", maxTokens: 8 });
    console.log(`- RESULTADO: OK. A API respondeu "${(r.text || "").trim().slice(0, 20)}" (${r.usage?.input_tokens || 0} tokens de entrada).`);
    console.log("- A proxima busca vai sair com veredito, gaps e palavras-chave de ATS.");
  } catch (error) {
    console.log(`- RESULTADO: FALHOU -> ${error.message}`);
    if (/workspace/i.test(error.message)) {
      console.log("- Causa: a chave e do tipo Pessoal com escopo 'Todos os espacos de trabalho'.");
      console.log("  Crie o secret ANTHROPIC_WORKSPACE_ID com o id (wrkspc_...) do seu workspace,");
      console.log("  ou gere uma chave presa a um workspace especifico.");
    } else if (/credit|balance|quota/i.test(error.message)) {
      console.log("- Causa provavel: credito de API insuficiente. Verifique em Faturamento no console.");
    }
  }
}
