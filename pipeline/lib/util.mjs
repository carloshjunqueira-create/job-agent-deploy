import crypto from "node:crypto";

export const DEFAULT_TIMEOUT_MS = 20000;
export const UA = "job-application-agent/3.0 (+https://github.com/carloshjunqueira-create/job-application-agent)";

/** Remove acentos, baixa a caixa e colapsa espacos. Base de toda comparacao textual. */
export function norm(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function stripHtml(value = "") {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|br|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function hashId(...parts) {
  return crypto.createHash("sha1").update(parts.map((p) => norm(p)).join("|")).digest("hex").slice(0, 16);
}

export function daysSince(dateish) {
  if (!dateish) return null;
  const d = new Date(dateish);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 86400000));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** fetch com timeout, retry e erro legivel. Nunca lanca sem contexto. */
export async function httpFetch(url, { method = "GET", headers = {}, body, timeout = DEFAULT_TIMEOUT_MS, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        method,
        headers: { "User-Agent": UA, Accept: "application/json, text/plain, */*", ...headers },
        body,
        signal: controller.signal,
        redirect: "follow"
      });
      clearTimeout(timer);
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status} em ${url}`);
        if (attempt < retries) { await sleep(1200 * (attempt + 1)); continue; }
        throw lastError;
      }
      if (!response.ok) {
        // Ler o corpo do erro: quase toda API diz ali qual parametro esta errado.
        // Sem isso, um 400 vira adivinhacao.
        let body = "";
        try { body = (await response.text()).replace(/\s+/g, " ").slice(0, 300); } catch { /* sem corpo */ }
        const error = new Error(`HTTP ${response.status} em ${url}${body ? ` | resposta: ${body}` : ""}`);
        error.status = response.status;
        // Erro do cliente (400, 401, 403, 404...): repetir nao muda nada. Marcamos
        // para o laco de retry nao insistir tres vezes no mesmo request invalido.
        error.noRetry = true;
        throw error;
      }
      return response;
    } catch (error) {
      clearTimeout(timer);
      if (error.noRetry) throw error;
      lastError = error.name === "AbortError" ? new Error(`timeout apos ${timeout}ms em ${url}`) : error;
      if (attempt < retries) { await sleep(1000 * (attempt + 1)); continue; }
      throw lastError;
    }
  }
  throw lastError;
}

export async function httpJson(url, options = {}) {
  const response = await httpFetch(url, options);
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`resposta nao e JSON valido em ${url} (inicio: ${text.slice(0, 120)})`);
  }
}

export async function httpText(url, options = {}) {
  const response = await httpFetch(url, options);
  return response.text();
}

/** Executa promessas com limite de concorrencia, sem derrubar a rodada por um item. */
export async function mapLimit(items, limit, worker) {
  const results = [];
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      try {
        results[current] = { ok: true, value: await worker(items[current], current) };
      } catch (error) {
        results[current] = { ok: false, error };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

export function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

const termRegexCache = new Map();
/**
 * Casamento por palavra inteira. Sem isso, termos curtos como "ai" ou "sp"
 * casam dentro de outras palavras ("mensais", "processo") e poluem o score.
 * Funciona com termos de varias palavras ("power bi", "melhoria continua").
 */
export function termMatches(haystack, term) {
  const needle = norm(term);
  if (!needle) return false;
  let regex = termRegexCache.get(needle);
  if (!regex) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`);
    termRegexCache.set(needle, regex);
  }
  return regex.test(haystack);
}

/** Devolve os termos da lista que aparecem no texto, como palavras inteiras. */
export function matchTerms(haystack, terms = []) {
  return terms.filter((t) => t && termMatches(haystack, t));
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function nowIso() {
  return new Date().toISOString();
}
