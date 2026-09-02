import { httpFetch } from "./util.mjs";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export function aiAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** Chamada crua a API. Lanca erro legivel; quem chama decide se degrada. */
export async function callClaude({ model, system, prompt, maxTokens = 4000, temperature = 0 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY nao configurada");
  const response = await httpFetch(API_URL, {
    method: "POST",
    timeout: 120000,
    retries: 2,
    headers: {
      "x-api-key": key,
      "anthropic-version": API_VERSION,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await response.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return { text, usage: data.usage || null };
}

/** Extrai JSON de uma resposta que pode vir com cerca de codigo ou texto em volta. */
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const bracket = candidate.indexOf("[");
  const brace = candidate.indexOf("{");
  let start;
  if (bracket >= 0 && (bracket < brace || brace < 0)) start = bracket;
  else start = brace;
  if (start < 0) return null;
  const openChar = candidate[start];
  const closeChar = openChar === "[" ? "]" : "}";
  const end = candidate.lastIndexOf(closeChar);
  if (end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

const RANK_SYSTEM = `Voce e um headhunter senior avaliando aderencia entre um profissional e vagas reais.
Seja rigoroso e honesto: nota alta so para aderencia real. Nao invente requisitos que a vaga nao pede
nem experiencias que o perfil nao tem. Responda SEMPRE e SOMENTE com JSON valido, sem texto em volta.`;

/**
 * Avalia um lote de vagas contra o perfil.
 * Retorna um mapa id -> { ai_score, verdict, why_fits, gaps, ats_missing, cv_variant, risk }
 */
export async function rankBatch({ jobs, profile, searchProfile, model, maxDescriptionChars = 4000 }) {
  const compactProfile = {
    positioning: profile.positioning,
    languages: profile.identity?.languages,
    experience: (profile.experience || []).map((e) => ({
      company: e.company, role: e.role, period: `${e.start || "?"} a ${e.end || "atual"}`,
      highlights: e.highlights, keywords: e.keywords
    })),
    skills: profile.skills,
    achievements: profile.achievements_bank,
    constraints: profile.constraints,
    cv_variants: Object.keys(profile.cv_variants || {})
  };

  const compactJobs = jobs.map((job) => ({
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location_raw,
    work_model: job.work_model,
    salary_brl_monthly: job.score?.salary_brl_monthly ?? null,
    posted_days_ago: job.age_days,
    description: (job.description || "").slice(0, maxDescriptionChars)
  }));

  const prompt = `PERFIL DO CANDIDATO (JSON):
${JSON.stringify(compactProfile, null, 1)}

CRITERIOS DECLARADOS PELO CANDIDATO:
- Cargos-alvo: ${(searchProfile.queries || []).join(", ")}
- Industrias prioritarias: ${(searchProfile.industries?.priority || []).join(", ")}
- Piso salarial: R$ ${searchProfile.salary?.min_brl_monthly} por mes (alvo R$ ${searchProfile.salary?.target_brl_monthly})
- Prioridade geografica, do mais para o menos desejado: ${(searchProfile.locations || []).filter((l) => l.enabled !== false).sort((a, b) => (b.weight || 0) - (a.weight || 0)).map((l) => l.label).join(" > ")}
- Deal breakers: funcoes predominantemente comerciais, de prospeccao ou de vendas

VAGAS PARA AVALIAR (JSON):
${JSON.stringify(compactJobs, null, 1)}

Para CADA vaga, devolva um objeto com estes campos exatos:
- "id": o id da vaga
- "ai_score": inteiro 0-100 de aderencia real do candidato a vaga. Use a escala inteira: 90+ so quando o candidato e claramente forte concorrente; 60-75 quando ha aderencia parcial; abaixo de 50 quando a vaga nao faz sentido.
- "verdict": uma frase curta em portugues dizendo se vale ou nao a candidatura e por que
- "why_fits": array de 2 a 4 pontos concretos de aderencia, citando evidencia do perfil
- "gaps": array de 1 a 3 lacunas ou pontos a confirmar; se nao houver, array vazio
- "ats_missing": array de ate 6 palavras-chave da vaga que provavelmente faltam no CV atual e deveriam entrar
- "cv_variant": uma das variantes disponiveis do CV que melhor serve a vaga
- "risk": "baixo", "medio" ou "alto" - risco de a vaga ser diferente do que parece (recrutamento generico, foco comercial disfarcado, senioridade incompativel)

Responda com um array JSON contendo um objeto por vaga, na mesma ordem. Sem comentarios, sem markdown.`;

  const { text, usage } = await callClaude({ model, system: RANK_SYSTEM, prompt, maxTokens: 8000 });
  const parsed = extractJson(text);
  if (!Array.isArray(parsed)) throw new Error("resposta da IA nao veio como array JSON");
  const map = new Map();
  for (const item of parsed) {
    if (item && item.id) map.set(item.id, item);
  }
  return { map, usage };
}

const TAILOR_SYSTEM = `Voce escreve materiais de candidatura em portugues do Brasil para um profissional real.
Regra absoluta: NAO invente experiencia, empresa, numero, certificacao ou resultado que nao esteja no perfil.
Quando faltar um dado que fortaleceria a peca, sinalize em "assumptions_to_confirm" em vez de inventar.
Tom: direto, executivo, sem jargao vazio e sem adjetivos de autoelogio. Responda SOMENTE com JSON valido.`;

/** Gera CV adaptado + carta de apresentacao para uma vaga especifica. */
export async function tailorForJob({ job, profile, model }) {
  const prompt = `PERFIL COMPLETO (JSON):
${JSON.stringify(profile, null, 1)}

VAGA:
Titulo: ${job.title}
Empresa: ${job.company}
Local: ${job.location_raw} (${job.work_model})
Link: ${job.url}
Descricao:
${(job.description || "").slice(0, 8000)}

Produza um JSON com estes campos:
- "cv_variant": qual variante do CV usar
- "headline": uma linha de titulo profissional otimizada para esta vaga (max 120 caracteres)
- "summary": resumo profissional de 3 a 4 linhas, escrito para esta vaga, so com fatos do perfil
- "bullets": array de 5 a 7 bullets de experiencia reescritos com a linguagem da vaga. Cada bullet: acao + contexto + resultado, comecando por verbo no passado. Use apenas fatos do perfil.
- "keywords_to_include": array de ate 12 palavras-chave da vaga que o CV precisa conter para passar em ATS
- "ats_gap": array de objetos { "keyword": "...", "how_to_cover": "como cobrir honestamente com o que ele ja fez, ou 'nao cobrir' se ele nao tem" }
- "cover_letter": carta de apresentacao de 200 a 280 palavras, em portugues, endereçada a empresa, com um paragrafo de abertura especifico sobre a empresa/vaga, um de evidencia e um de fechamento com proximo passo. Sem cliche de "sempre fui apaixonado por".
- "cover_letter_en": a mesma carta em ingles, apenas se a vaga for internacional ou pedir ingles; caso contrario string vazia
- "interview_angles": array de 3 perguntas provaveis desta vaga com um esboco de resposta baseado no perfil
- "assumptions_to_confirm": array de dados que faltaram e que ele deveria preencher antes de enviar

Somente JSON.`;

  const { text, usage } = await callClaude({ model, system: TAILOR_SYSTEM, prompt, maxTokens: 6000, temperature: 0.3 });
  const parsed = extractJson(text);
  if (!parsed) throw new Error("resposta da IA nao veio como JSON valido");
  return { result: parsed, usage };
}
