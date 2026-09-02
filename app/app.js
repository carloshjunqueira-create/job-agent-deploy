/* Job Application Agent — interface v3
   O site é estático. O trabalho pesado roda no GitHub Actions; aqui a gente lê o feed,
   decide, edita critérios e dispara novas rodadas. */

const VERSION = "3.0.0";
const WORKFLOW_COLLECT = "collect.yml";
const WORKFLOW_TAILOR = "tailor.yml";
const LS = {
  token: "ja.gh.token",
  repo: "ja.gh.repo",
  decisions: "ja.decisions.v3",
  filters: "ja.filters.v3"
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (v = "") => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
const money = (v) => (v ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v) : null);
const lines = (v) => String(v || "").split("\n").map((s) => s.trim()).filter(Boolean);
const safeUrl = (v) => { try { const u = new URL(v); return ["http:", "https:"].includes(u.protocol) ? u.href : ""; } catch { return ""; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATUS = {
  applied: "Me candidatei",
  interested: "Tenho interesse",
  saved: "Salva",
  rejected: "Não tenho interesse",
  closed: "Vaga fechada",
  invalid_link: "Link inválido"
};
const REMOVES_FROM_FEED = new Set(["applied", "rejected", "closed", "invalid_link"]);

const state = {
  feed: { jobs: [] },
  config: null,
  runs: { runs: [] },
  tailoredIndex: { items: {} },
  decisions: {},
  filters: { text: "", bucket: "", score: 0, salaryOnly: false, sort: "final", status: "" }
};

/* ============================ GitHub ============================ */
const gh = {
  get token() { return localStorage.getItem(LS.token) || ""; },
  set token(v) { v ? localStorage.setItem(LS.token, v) : localStorage.removeItem(LS.token); },
  get repo() {
    const saved = localStorage.getItem(LS.repo);
    if (saved) return saved;
    const host = location.hostname.match(/^([\w-]+)\.github\.io$/i);
    const seg = location.pathname.split("/").filter(Boolean);
    if (host && seg.length) return `${host[1]}/${seg[0]}`;
    return "carloshjunqueira-create/job-application-agent";
  },
  set repo(v) { v ? localStorage.setItem(LS.repo, v) : localStorage.removeItem(LS.repo); },
  get connected() { return Boolean(this.token); },

  async api(path, options = {}) {
    const res = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers
      }
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).message || ""; } catch { /* corpo vazio */ }
      throw new Error(`GitHub ${res.status}: ${detail || res.statusText}`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  },

  /** Lê um arquivo do repositório em texto cru — sempre a versão mais recente, sem cache de CDN. */
  async readFile(path) {
    try {
      const raw = await this.api(`/repos/${this.repo}/contents/${path}?ref=main&t=${Date.now()}`, {
        headers: { Accept: "application/vnd.github.raw" }
      });
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch { return null; }
  },

  async getSha(path) {
    try {
      const meta = await this.api(`/repos/${this.repo}/contents/${path}?ref=main`);
      return meta?.sha || null;
    } catch { return null; }
  },

  async writeFile(path, contentObject, message) {
    const text = JSON.stringify(contentObject, null, 2) + "\n";
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    const sha = await this.getSha(path);
    return this.api(`/repos/${this.repo}/contents/${path}`, {
      method: "PUT",
      body: JSON.stringify({ message, content: btoa(binary), sha: sha || undefined, branch: "main" })
    });
  },

  async dispatch(workflow, inputs) {
    await this.api(`/repos/${this.repo}/actions/workflows/${workflow}/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref: "main", inputs })
    });
  },

  async latestRun(workflow) {
    const data = await this.api(`/repos/${this.repo}/actions/workflows/${workflow}/runs?per_page=1`);
    return data?.workflow_runs?.[0] || null;
  }
};

/* ============================ Carregamento ============================ */
async function loadJson(relPath, fallback) {
  if (gh.connected) {
    const viaApi = await gh.readFile(`data/${relPath}`);
    if (viaApi) return viaApi;
  }
  try {
    const res = await fetch(`../data/${relPath}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } catch { return fallback; }
}

async function loadConfig() {
  if (gh.connected) {
    const viaApi = await gh.readFile("config/search-profiles.json");
    if (viaApi) return viaApi;
  }
  try {
    const res = await fetch(`../config/search-profiles.json?t=${Date.now()}`, { cache: "no-store" });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function loadAll({ quiet = false } = {}) {
  if (!quiet) setStatus("Carregando…");
  const [feed, runs, tailored, config, remoteDecisions] = await Promise.all([
    loadJson("feed.json", { jobs: [] }),
    loadJson("runs.json", { runs: [] }),
    loadJson("tailored/index.json", { items: {} }),
    loadConfig(),
    loadJson("decisions.json", { decisions: {} })
  ]);
  state.feed = feed && Array.isArray(feed.jobs) ? feed : { jobs: [] };
  state.runs = runs || { runs: [] };
  state.tailoredIndex = tailored || { items: {} };
  state.config = config;

  // As decisões locais mandam; o repositório completa o que faltar (outro navegador ou dispositivo).
  const local = JSON.parse(localStorage.getItem(LS.decisions) || "{}");
  state.decisions = { ...(remoteDecisions?.decisions || {}), ...local };
  persistDecisionsLocal();

  hydrateCriteriaForm();
  renderAll();
}

/* ============================ Decisões ============================ */
function persistDecisionsLocal() {
  localStorage.setItem(LS.decisions, JSON.stringify(state.decisions));
}

let syncTimer = null;
function syncDecisions() {
  if (!gh.connected) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      await gh.writeFile("data/decisions.json", {
        schema_version: "1.0.0",
        updated_at: new Date().toISOString(),
        decisions: state.decisions
      }, "decisoes: atualizacao pela interface");
    } catch (error) {
      toast(`Não consegui salvar as decisões no GitHub: ${error.message}`);
    }
  }, 1500);
}

function decide(jobId, status) {
  const job = state.feed.jobs.find((j) => j.id === jobId) || null;
  const previous = state.decisions[jobId] || {};
  state.decisions[jobId] = {
    status,
    at: new Date().toISOString(),
    title: job?.title || previous.title || "",
    company: job?.company || previous.company || "",
    url: job?.url || previous.url || "",
    score: job?.score?.final ?? previous.score ?? null
  };
  persistDecisionsLocal();
  syncDecisions();
  renderAll();
  toast(`${STATUS[status]}: ${job?.title || "vaga"}`);
}

function undecide(jobId) {
  delete state.decisions[jobId];
  persistDecisionsLocal();
  syncDecisions();
  renderAll();
}

/* ============================ Render ============================ */
function scoreClass(v) { return v >= 80 ? "s-high" : v >= 65 ? "s-mid" : "s-low"; }

function visibleJobs() {
  const f = state.filters;
  return state.feed.jobs
    .filter((j) => {
      const decision = state.decisions[j.id];
      if (decision && REMOVES_FROM_FEED.has(decision.status)) return false;
      if (f.bucket && j.location_bucket !== f.bucket) return false;
      if (f.score && (j.score?.final ?? 0) < f.score) return false;
      if (f.salaryOnly && !j.salary_brl_monthly) return false;
      if (f.text) {
        const hay = `${j.title} ${j.company} ${j.location} ${(j.why_fits || []).join(" ")} ${j.verdict || ""}`.toLowerCase();
        if (!hay.includes(f.text.toLowerCase())) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (f.sort === "recent") return (a.age_days ?? 999) - (b.age_days ?? 999);
      if (f.sort === "salary") return (b.salary_brl_monthly || 0) - (a.salary_brl_monthly || 0);
      return (b.score?.final ?? 0) - (a.score?.final ?? 0);
    });
}

function jobCard(job) {
  const decision = state.decisions[job.id];
  const url = safeUrl(job.url);
  const salary = money(job.salary_brl_monthly);
  const hasMaterial = Boolean(state.tailoredIndex.items?.[job.id]);
  const riskTag = job.risk === "alto" ? '<span class="tag t-bad">risco alto</span>'
    : job.risk === "medio" ? '<span class="tag t-warn">risco médio</span>' : "";
  const isCompanyPage = /\/company\//i.test(url);

  return `
  <article class="card" data-job="${esc(job.id)}">
    <div class="card-head">
      <div class="score ${scoreClass(job.score?.final ?? 0)}">
        <b>${job.score?.final ?? "—"}</b><span>score</span>
      </div>
      <div class="card-title">
        <h3>${esc(job.title)}</h3>
        <div class="company">${esc(job.company)}${job.location ? ` · ${esc(job.location)}` : ""}</div>
        <div class="tags">
          ${job.location_label ? `<span class="tag t-loc">${esc(job.location_label)}</span>` : ""}
          ${job.work_model && job.work_model !== "unknown" ? `<span class="tag">${esc(job.work_model)}</span>` : ""}
          ${salary ? `<span class="tag t-good">${salary}/mês</span>` : '<span class="tag">salário não divulgado</span>'}
          ${job.age_days != null ? `<span class="tag">${job.age_days === 0 ? "hoje" : `há ${job.age_days}d`}</span>` : ""}
          <span class="tag">${esc((job.also_seen_in && job.also_seen_in.length ? job.also_seen_in : [job.source]).join(" + "))}</span>
          ${job.score?.ai != null ? `<span class="tag">IA ${job.score.ai} · regras ${job.score.rules}</span>` : '<span class="tag t-warn">sem avaliação da IA</span>'}
          ${riskTag}
          ${isCompanyPage ? '<span class="tag t-warn">o link parece ser da empresa, não da vaga</span>' : ""}
          ${decision ? `<span class="tag t-loc">${esc(STATUS[decision.status] || decision.status)}</span>` : ""}
        </div>
      </div>
    </div>

    ${job.verdict ? `<p class="verdict">${esc(job.verdict)}</p>` : ""}

    <div class="lists">
      <div>
        <h4>Por que serve</h4>
        <ul>${(job.why_fits || []).map((r) => `<li>${esc(r)}</li>`).join("") || "<li>—</li>"}</ul>
      </div>
      <div>
        <h4>Pontos de atenção</h4>
        <ul>${(job.gaps || []).map((r) => `<li>${esc(r)}</li>`).join("") || "<li>Nada relevante identificado</li>"}</ul>
      </div>
    </div>

    ${(job.ats_missing || []).length ? `<p class="ats"><b>Palavras-chave que faltam no seu CV:</b> ${job.ats_missing.map(esc).join(" · ")}</p>` : ""}

    ${job.description_excerpt ? `<details class="details"><summary>Ver trecho da descrição</summary><pre>${esc(job.description_excerpt)}</pre></details>` : ""}

    <div class="actions">
      ${url ? `<a class="btn btn-primary btn-small" href="${esc(url)}" target="_blank" rel="noopener">Abrir vaga</a>` : ""}
      ${hasMaterial
        ? '<button class="btn btn-small" data-action="tailor">Ver materiais</button>'
        : '<button class="btn btn-small" data-action="tailor" data-mode="cv">Gerar só o CV</button><button class="btn btn-small" data-action="tailor" data-mode="full">CV + carta</button>'}
      <button class="btn btn-small" data-action="decide" data-status="applied">Me candidatei</button>
      <button class="btn btn-small" data-action="decide" data-status="interested">Tenho interesse</button>
      <button class="btn btn-small" data-action="decide" data-status="saved">Salvar</button>
      <button class="btn btn-small" data-action="decide" data-status="rejected">Não</button>
      <button class="btn btn-small" data-action="decide" data-status="closed">Fechada</button>
      <button class="btn btn-small" data-action="decide" data-status="invalid_link">Link inválido</button>
    </div>
  </article>`;
}

function renderFeed() {
  const jobs = visibleJobs();
  $("#count-feed").textContent = jobs.length;
  $("#feed").innerHTML = jobs.map(jobCard).join("");
  const empty = $("#feed-empty");
  if (jobs.length) { empty.hidden = true; return; }
  empty.hidden = false;
  empty.innerHTML = state.feed.jobs.length
    ? "Nenhuma vaga passa nos filtros atuais. Afrouxe o score mínimo ou limpe o texto de busca."
    : "Feed vazio. Clique em <b>Nova busca</b> para a primeira rodada — ou rode o workflow <b>Buscar vagas</b> na aba Actions do repositório.";
}

function renderHistorico() {
  const entries = Object.entries(state.decisions)
    .filter(([, d]) => !state.filters.status || d.status === state.filters.status)
    .sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
  $("#count-historico").textContent = Object.keys(state.decisions).length;
  $("#historico-empty").hidden = entries.length > 0;
  $("#historico").innerHTML = entries.map(([id, d]) => `
    <article class="card" data-job="${esc(id)}">
      <div class="card-head">
        <div class="score ${scoreClass(d.score ?? 0)}"><b>${d.score ?? "—"}</b><span>score</span></div>
        <div class="card-title">
          <h3>${esc(d.title || "(vaga sem título registrado)")}</h3>
          <div class="company">${esc(d.company || "")}</div>
          <div class="tags">
            <span class="tag t-loc">${esc(STATUS[d.status] || d.status)}</span>
            <span class="tag">${new Date(d.at).toLocaleString("pt-BR")}</span>
          </div>
        </div>
      </div>
      <div class="actions">
        ${safeUrl(d.url) ? `<a class="btn btn-small" href="${esc(safeUrl(d.url))}" target="_blank" rel="noopener">Abrir vaga</a>` : ""}
        <button class="btn btn-small" data-action="undecide">Desfazer decisão</button>
      </div>
    </article>`).join("");
}

function renderMateriais() {
  const items = Object.entries(state.tailoredIndex.items || {})
    .sort((a, b) => String(b[1].generated_at).localeCompare(String(a[1].generated_at)));
  $("#count-materiais").textContent = items.length;
  $("#materiais-empty").hidden = items.length > 0;
  $("#materiais").innerHTML = items.map(([id, m]) => `
    <article class="card" data-job="${esc(id)}">
      <div class="card-title">
        <h3>${esc(m.title)}</h3>
        <div class="company">${esc(m.company)}</div>
        <div class="tags"><span class="tag">gerado em ${new Date(m.generated_at).toLocaleString("pt-BR")}</span></div>
      </div>
      <div class="actions"><button class="btn btn-small btn-primary" data-action="tailor">Abrir CV + carta</button></div>
    </article>`).join("");
}

function renderRodadas() {
  const runs = state.runs.runs || [];
  $("#rodadas").innerHTML = runs.length ? runs.map((r) => `
    <div class="run-card">
      <h3>${new Date(r.finished_at).toLocaleString("pt-BR")} · ${esc(r.search_profile)}</h3>
      <div class="tags">
        <span class="tag">${r.counts.raw} coletadas</span>
        <span class="tag">${r.counts.unique} únicas</span>
        <span class="tag">${r.counts.passed_filters} passaram nos filtros</span>
        <span class="tag t-good">${r.counts.published} publicadas</span>
        <span class="tag">${(r.duration_ms / 1000).toFixed(0)}s</span>
        ${r.ai?.enabled
          ? `<span class="tag">IA ${esc(r.ai.model)}</span><span class="tag">${(r.ai.input_tokens || 0).toLocaleString("pt-BR")} tokens entrada</span>${r.ai.estimated_cost_usd != null ? `<span class="tag t-good">US$ ${r.ai.estimated_cost_usd.toFixed(4)}</span>` : ""}`
          : '<span class="tag t-warn">sem IA · custo zero</span>'}
      </div>
      ${r.extra_queries?.length ? `<p class="ats"><b>Termos extras:</b> ${r.extra_queries.map(esc).join(" · ")}</p>` : ""}
      <div class="table-wrap"><table>
        <tr><th>Fonte</th><th>Status</th><th>Vagas</th><th>Observação</th></tr>
        ${(r.sources || []).map((s) => `<tr>
          <td>${esc(s.label)}</td>
          <td class="status-${esc(s.status)}">${esc(s.status)}</td>
          <td>${s.jobs}</td>
          <td>${esc((s.detail || "").slice(0, 90))}</td>
        </tr>`).join("")}
      </table></div>
      ${Object.keys(r.blocked_reasons || {}).length ? `<p class="ats"><b>Descartes:</b> ${Object.entries(r.blocked_reasons).map(([k, v]) => `${esc(k)} (${v})`).join(" · ")}</p>` : ""}
    </div>`).join("") : '<div class="empty">Nenhuma rodada registrada ainda.</div>';
}

function setStatus(html) { $("#run-status").innerHTML = html; }

function renderStatus() {
  const generated = state.feed.generated_at ? new Date(state.feed.generated_at) : null;
  const last = state.runs.runs?.[0];
  const failedSources = (last?.sources || []).filter((s) => s.status === "ERRO").length;
  const parts = [];
  parts.push(generated ? `Feed de <b>${generated.toLocaleString("pt-BR")}</b>` : "Nenhuma rodada ainda");
  parts.push(`<b>${state.feed.jobs.length}</b> vagas`);
  if (last && last.ai?.enabled === false) parts.push("IA desligada na última rodada");
  if (failedSources) parts.push(`<b>${failedSources}</b> fonte(s) com erro`);
  parts.push(gh.connected ? "conectado ao GitHub" : "não conectado");
  setStatus(parts.join(" · "));
  $("#btn-connect").textContent = gh.connected ? "Conectado" : "Conectar";
}

function renderAll() { renderStatus(); renderFeed(); renderMateriais(); renderHistorico(); renderRodadas(); }

/* ============================ Critérios ============================ */
function activeProfile() {
  if (!state.config) return null;
  return state.config.profiles.find((p) => p.id === state.config.active_profile) || state.config.profiles[0];
}

function hydrateCriteriaForm() {
  const p = activeProfile();
  const statusSelect = $("#filter-status");
  statusSelect.innerHTML = '<option value="">Todas as decisões</option>' +
    Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  statusSelect.value = state.filters.status || "";
  if (!p) return;

  $("#cfg-queries").value = (p.queries || []).join("\n");
  $("#cfg-queries-intl").value = (p.queries_international || []).join("\n");
  $("#cfg-salary-min").value = p.salary?.min_brl_monthly ?? "";
  $("#cfg-salary-target").value = p.salary?.target_brl_monthly ?? "";
  $("#cfg-salary-block").checked = p.salary?.below_minimum_action === "BLOCK";
  $("#cfg-salary-intl").value = p.salary?.international_min_usd_annual ?? "";
  $("#cfg-deal-titles").value = (p.deal_breakers?.title_terms || []).join("\n");
  $("#cfg-seniority-exclude").value = (p.seniority?.exclude_titles || []).join("\n");
  $("#cfg-companies-blocked").value = (p.deal_breakers?.companies_blocked || []).join("\n");
  $("#cfg-industries").value = (p.industries?.priority || []).join("\n");
  $("#cfg-feed-size").value = p.filters?.feed_size ?? 45;
  $("#cfg-min-score").value = p.filters?.min_final_score_to_show ?? 60;
  $("#cfg-recency").value = p.filters?.recency_days_max ?? 45;
  $("#cfg-max-company").value = p.filters?.max_per_company ?? 3;
  $("#cfg-ai-enabled").checked = p.ai_ranking?.enabled !== false;
  $("#cfg-ai-candidates").value = p.ai_ranking?.candidates_sent_to_ai ?? 60;

  // As opções de modelo e os preços vêm da própria configuração do repositório,
  // então adicionar ou remover um modelo não exige mexer nesta página.
  const pricing = state.config.ai_pricing_usd_per_mtok || {};
  const modelOptions = Object.entries(pricing)
    .map(([id, info]) => `<option value="${esc(id)}">${esc(info.label || id)} — US$ ${info.input}/${info.output} por Mtok</option>`)
    .join("");
  $("#cfg-ai-model").innerHTML = modelOptions;
  $("#cfg-ai-model-tailor").innerHTML = modelOptions;
  $("#cfg-ai-model").value = p.ai_ranking?.model || "claude-sonnet-5";
  $("#cfg-ai-model-tailor").value = p.ai_tailoring?.model || p.ai_ranking?.model || "claude-sonnet-5";
  renderCostEstimate();

  $("#cfg-locations").innerHTML = (p.locations || []).map((l, i) => `
    <div class="loc-row" data-index="${i}">
      <input type="checkbox" class="loc-enabled" ${l.enabled !== false ? "checked" : ""} title="incluir esta região">
      <div class="loc-name">${esc(l.label)}<small>${esc(l.kind)}</small></div>
      <input type="number" class="loc-weight" step="0.05" min="0" max="1" value="${l.weight ?? 1}" title="peso (prioridade)">
      <input type="number" class="loc-quota" step="0.05" min="0" max="1" value="${l.quota ?? 0}" title="cota no feed">
    </div>`).join("");

  const bucketSelect = $("#filter-bucket");
  bucketSelect.innerHTML = '<option value="">Todas as regiões</option>' +
    (p.locations || []).map((l) => `<option value="${esc(l.id)}">${esc(l.label)}</option>`).join("");
  bucketSelect.value = state.filters.bucket || "";
}

/**
 * Estimativa de custo por rodada, na tela, antes de gastar.
 * Base: ~1.300 tokens de entrada por vaga enviada (descrição cortada em 4.000
 * caracteres) mais o perfil repetido a cada lote, e ~220 tokens de saída por vaga.
 * É aproximação — o valor real de cada rodada aparece na aba Rodadas.
 */
function renderCostEstimate() {
  const target = $("#cost-estimate");
  if (!target || !state.config) return;
  const pricing = state.config.ai_pricing_usd_per_mtok || {};
  const model = $("#cfg-ai-model").value;
  const price = pricing[model];
  const candidates = Number($("#cfg-ai-candidates").value) || 60;
  if (!price || !$("#cfg-ai-enabled").checked) {
    target.textContent = $("#cfg-ai-enabled").checked ? "" : "IA desligada: as rodadas não custam nada e o feed sai só com o score de regras.";
    return;
  }
  const profileActive = activeProfile();
  const batchSize = profileActive?.ai_ranking?.batch_size || 12;
  const batches = Math.ceil(candidates / batchSize);
  const inputTokens = candidates * 1300 + batches * 900;
  const outputTokens = candidates * 220;
  const cost = (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;

  const tailorModel = $("#cfg-ai-model-tailor").value;
  const tailorPrice = pricing[tailorModel];
  const tailorCost = tailorPrice ? (9000 / 1e6) * tailorPrice.input + (2500 / 1e6) * tailorPrice.output : null;

  target.innerHTML = `Estimativa: <b>US$ ${cost.toFixed(2)}</b> por busca (${candidates} vagas na IA)` +
    (tailorCost != null ? ` · <b>US$ ${tailorCost.toFixed(3)}</b> por CV + carta gerado` : "");
}

function readCriteriaForm() {
  const config = JSON.parse(JSON.stringify(state.config));
  const p = config.profiles.find((x) => x.id === config.active_profile) || config.profiles[0];
  p.queries = lines($("#cfg-queries").value);
  p.queries_international = lines($("#cfg-queries-intl").value);
  p.salary = p.salary || {};
  p.salary.min_brl_monthly = Number($("#cfg-salary-min").value) || 0;
  p.salary.target_brl_monthly = Number($("#cfg-salary-target").value) || 0;
  p.salary.below_minimum_action = $("#cfg-salary-block").checked ? "BLOCK" : "PENALIZE";
  p.salary.international_min_usd_annual = Number($("#cfg-salary-intl").value) || 0;
  p.deal_breakers = p.deal_breakers || {};
  p.deal_breakers.title_terms = lines($("#cfg-deal-titles").value);
  p.deal_breakers.companies_blocked = lines($("#cfg-companies-blocked").value);
  p.seniority = p.seniority || {};
  p.seniority.exclude_titles = lines($("#cfg-seniority-exclude").value);
  p.industries = p.industries || {};
  p.industries.priority = lines($("#cfg-industries").value);
  p.filters = p.filters || {};
  p.filters.feed_size = Number($("#cfg-feed-size").value) || 45;
  p.filters.min_final_score_to_show = Number($("#cfg-min-score").value) || 0;
  p.filters.recency_days_max = Number($("#cfg-recency").value) || 45;
  p.filters.max_per_company = Number($("#cfg-max-company").value) || 3;
  p.ai_ranking = p.ai_ranking || {};
  p.ai_ranking.enabled = $("#cfg-ai-enabled").checked;
  p.ai_ranking.model = $("#cfg-ai-model").value;
  p.ai_ranking.candidates_sent_to_ai = Number($("#cfg-ai-candidates").value) || 60;
  p.ai_tailoring = p.ai_tailoring || {};
  p.ai_tailoring.enabled = true;
  p.ai_tailoring.model = $("#cfg-ai-model-tailor").value;
  $$("#cfg-locations .loc-row").forEach((row) => {
    const loc = p.locations[Number(row.dataset.index)];
    if (!loc) return;
    loc.enabled = $(".loc-enabled", row).checked;
    loc.weight = Number($(".loc-weight", row).value);
    loc.quota = Number($(".loc-quota", row).value);
  });
  config.updated_at = new Date().toISOString().slice(0, 10);
  return config;
}

/* ============================ Busca ============================ */
async function runSearch() {
  const button = $("#btn-run-search");
  const progress = $("#search-progress");
  progress.hidden = false;
  if (!gh.connected) {
    progress.textContent = 'Você ainda não conectou o token do GitHub. Clique em "Conectar" no topo, ou rode o workflow "Buscar vagas" manualmente na aba Actions do repositório.';
    return;
  }
  button.disabled = true;
  progress.textContent = "Disparando a busca…";
  const startedAt = Date.now();
  try {
    await gh.dispatch(WORKFLOW_COLLECT, {
      extra_queries: $("#search-extra").value.trim(),
      profile: "",
      skip_ai: $("#search-skip-ai").checked ? "true" : "false"
    });
    progress.textContent = "Busca disparada. Aguardando o GitHub iniciar a rodada…";
    const run = await waitForRun(WORKFLOW_COLLECT, startedAt, progress);
    if (run?.conclusion === "success") {
      progress.textContent = "Rodada concluída. Carregando o novo feed…";
      await sleep(2500);
      await loadAll({ quiet: true });
      progress.textContent = `Pronto: ${state.feed.jobs.length} vagas no feed.`;
      toast(`Feed atualizado: ${state.feed.jobs.length} vagas`);
    } else {
      progress.textContent = `A rodada terminou como "${run?.conclusion || "sem resposta"}". Abra os logs no GitHub para ver qual etapa falhou:\n${run?.html_url || ""}`;
    }
  } catch (error) {
    progress.textContent = `Não consegui disparar a busca: ${error.message}\n\nVerifique se o token tem permissão de Actions (read and write) neste repositório.`;
  } finally {
    button.disabled = false;
  }
}

async function waitForRun(workflow, startedAt, progress) {
  const deadline = Date.now() + 8 * 60 * 1000;
  let run = null;
  while (Date.now() < deadline) {
    await sleep(6000);
    try {
      const latest = await gh.latestRun(workflow);
      if (latest && new Date(latest.created_at).getTime() >= startedAt - 60000) {
        run = latest;
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        progress.textContent = `Rodada em andamento (${latest.status})… ${elapsed}s\n${latest.html_url}`;
        if (latest.status === "completed") return latest;
      } else {
        progress.textContent = "Aguardando o GitHub iniciar a rodada…";
      }
    } catch (error) {
      progress.textContent = `Perdi o acompanhamento da rodada (${error.message}). Ela continua rodando no GitHub.`;
    }
  }
  return run;
}

async function generateMaterial(jobId, mode = "full") {
  if (state.tailoredIndex.items?.[jobId]) return openMaterial(jobId);
  if (!gh.connected) return toast("Conecte o token do GitHub para gerar os materiais.");
  toast(mode === "cv" ? "Gerando o CV adaptado… leva cerca de um minuto." : "Gerando CV e carta… leva cerca de um minuto.");
  const startedAt = Date.now();
  try {
    await gh.dispatch(WORKFLOW_TAILOR, { job_id: jobId, mode });
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(8000);
      const run = await gh.latestRun(WORKFLOW_TAILOR);
      if (run && new Date(run.created_at).getTime() >= startedAt - 60000 && run.status === "completed") {
        if (run.conclusion !== "success") { toast("A geração falhou. Veja os logs no GitHub."); return; }
        await sleep(2500);
        state.tailoredIndex = await loadJson("tailored/index.json", { items: {} });
        renderAll();
        return openMaterial(jobId);
      }
    }
    toast("A geração demorou mais que o esperado. Recarregue a página em instantes.");
  } catch (error) {
    toast(`Não consegui gerar: ${error.message}`);
  }
}

async function openMaterial(jobId) {
  const data = await loadJson(`tailored/${jobId}.json`, null);
  if (!data) return toast("Material ainda não disponível. Tente novamente em instantes.");
  $("#material-title").textContent = `${data.job?.title || ""} · ${data.job?.company || ""}${data.mode === "so-cv" ? " · só CV" : ""}`;
  const block = (title, content) => content ? `
    <h3>${esc(title)}</h3>
    <div class="block">${esc(content)}</div>
    <button class="btn btn-small copy" data-action="copy">Copiar</button>` : "";
  const list = (title, items) => items?.length ? `
    <h3>${esc(title)}</h3>
    <div class="block">${items.map((i) => `• ${esc(typeof i === "string" ? i : JSON.stringify(i))}`).join("\n")}</div>
    <button class="btn btn-small copy" data-action="copy">Copiar</button>` : "";

  $("#material-body").innerHTML = [
    block("Headline", data.headline),
    block("Resumo profissional", data.summary),
    list("Bullets de experiência", data.bullets),
    list("Palavras-chave para o ATS", data.keywords_to_include),
    data.ats_gap?.length
      ? `<h3>Gap de ATS</h3><div class="block">${data.ats_gap.map((g) => `• ${esc(g.keyword)} — ${esc(g.how_to_cover)}`).join("\n")}</div><button class="btn btn-small copy" data-action="copy">Copiar</button>`
      : "",
    block("Carta de apresentação", data.cover_letter),
    block("Cover letter (inglês)", data.cover_letter_en),
    data.interview_angles?.length
      ? `<h3>Preparação para entrevista</h3><div class="block">${data.interview_angles.map((q) => `• ${esc(typeof q === "string" ? q : `${q.question || q.pergunta || ""} → ${q.answer || q.resposta || ""}`)}`).join("\n\n")}</div><button class="btn btn-small copy" data-action="copy">Copiar</button>`
      : "",
    list("Confirmar antes de enviar", data.assumptions_to_confirm)
  ].join("");
  $("#modal-material").hidden = false;
}

/* ============================ UI ============================ */
let toastTimer = null;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

function bind() {
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.toggle("is-active", t === tab));
    $$(".tab-panel").forEach((p) => p.classList.toggle("is-active", p.id === `tab-${tab.dataset.tab}`));
  }));

  $("#btn-criteria").addEventListener("click", () => { $("#drawer-criteria").hidden = false; });
  $$("[data-close-drawer]").forEach((b) => b.addEventListener("click", () => { $("#drawer-criteria").hidden = true; }));
  $$("[data-close-modal]").forEach((b) => b.addEventListener("click", () => { b.closest(".modal").hidden = true; }));
  $$(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) m.hidden = true; }));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    $$(".modal").forEach((m) => { m.hidden = true; });
    $("#drawer-criteria").hidden = true;
  });

  $("#btn-search").addEventListener("click", () => {
    $("#search-progress").hidden = true;
    $("#modal-search").hidden = false;
  });
  $("#btn-run-search").addEventListener("click", runSearch);

  $("#btn-connect").addEventListener("click", () => {
    $("#connect-repo").value = gh.repo;
    $("#connect-token").value = gh.token;
    $("#connect-status").textContent = "";
    $("#modal-connect").hidden = false;
  });

  $("#btn-save-token").addEventListener("click", async () => {
    const status = $("#connect-status");
    gh.repo = $("#connect-repo").value.trim();
    gh.token = $("#connect-token").value.trim();
    status.className = "connect-status";
    status.textContent = "Testando…";
    try {
      const repo = await gh.api(`/repos/${gh.repo}`);
      status.className = "connect-status ok";
      status.textContent = `Conectado a ${repo.full_name}.`;
      await loadAll({ quiet: true });
    } catch (error) {
      status.className = "connect-status err";
      status.textContent = `Falhou: ${error.message}`;
    }
    renderStatus();
  });

  $("#btn-clear-token").addEventListener("click", () => {
    gh.token = "";
    $("#connect-token").value = "";
    $("#connect-status").className = "connect-status";
    $("#connect-status").textContent = "Token removido deste navegador.";
    renderStatus();
  });

  $("#btn-save-criteria").addEventListener("click", async () => {
    if (!state.config) return toast("Não consegui ler a configuração atual do repositório.");
    const config = readCriteriaForm();
    state.config = config;
    if (!gh.connected) {
      downloadJson(config, "search-profiles.json");
      return toast("Sem token: baixei o JSON. Suba em config/search-profiles.json.");
    }
    try {
      await gh.writeFile("config/search-profiles.json", config, "criterios: ajuste pela interface");
      toast("Critérios salvos. A próxima busca já usa estes filtros.");
      $("#drawer-criteria").hidden = true;
    } catch (error) {
      toast(`Não consegui salvar: ${error.message}`);
    }
  });

  ["#cfg-ai-model", "#cfg-ai-model-tailor", "#cfg-ai-candidates", "#cfg-ai-enabled"].forEach((sel) => {
    $(sel).addEventListener("change", renderCostEstimate);
    $(sel).addEventListener("input", renderCostEstimate);
  });

  $("#btn-download-criteria").addEventListener("click", () => {
    if (!state.config) return toast("Configuração ainda não carregada.");
    downloadJson(readCriteriaForm(), "search-profiles.json");
  });

  $("#filter-text").addEventListener("input", (e) => { state.filters.text = e.target.value; renderFeed(); saveFilters(); });
  $("#filter-bucket").addEventListener("change", (e) => { state.filters.bucket = e.target.value; renderFeed(); saveFilters(); });
  $("#filter-score").addEventListener("input", (e) => {
    state.filters.score = Number(e.target.value);
    $("#filter-score-value").textContent = e.target.value;
    renderFeed(); saveFilters();
  });
  $("#filter-salary").addEventListener("change", (e) => { state.filters.salaryOnly = e.target.checked; renderFeed(); saveFilters(); });
  $("#sort-by").addEventListener("change", (e) => { state.filters.sort = e.target.value; renderFeed(); saveFilters(); });
  $("#filter-status").addEventListener("change", (e) => { state.filters.status = e.target.value; renderHistorico(); saveFilters(); });

  $("#btn-export-decisions").addEventListener("click", () => downloadJson({ decisions: state.decisions }, "decisoes.json"));
  $("#btn-import-decisions").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      state.decisions = { ...state.decisions, ...(parsed.decisions || parsed) };
      persistDecisionsLocal(); syncDecisions(); renderAll();
      toast("Decisões importadas.");
    } catch { toast("Arquivo inválido."); }
    e.target.value = "";
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "copy") {
      const block = button.previousElementSibling;
      navigator.clipboard.writeText(block?.textContent || "").then(() => toast("Copiado."), () => toast("Não consegui copiar."));
      return;
    }
    const card = button.closest("[data-job]");
    if (!card) return;
    const jobId = card.dataset.job;
    if (action === "decide") decide(jobId, button.dataset.status);
    if (action === "undecide") undecide(jobId);
    if (action === "tailor") generateMaterial(jobId, button.dataset.mode || "full");
  });
}

function saveFilters() { localStorage.setItem(LS.filters, JSON.stringify(state.filters)); }
function restoreFilters() {
  try { Object.assign(state.filters, JSON.parse(localStorage.getItem(LS.filters) || "{}")); } catch { /* ignora */ }
  $("#filter-text").value = state.filters.text || "";
  $("#filter-score").value = state.filters.score || 0;
  $("#filter-score-value").textContent = state.filters.score || 0;
  $("#filter-salary").checked = Boolean(state.filters.salaryOnly);
  $("#sort-by").value = state.filters.sort || "final";
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

// Remove o service worker da versão anterior, que servia a interface antiga em cache.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister())).catch(() => {});
}

bind();
restoreFilters();
loadAll();
console.log(`Job Application Agent v${VERSION}`);
