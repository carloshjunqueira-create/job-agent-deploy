# Job Application Agent

Agente de busca e triagem de vagas. O site publicado no GitHub Pages é a interface; o **GitHub Actions é o backend**. Nada de gerar JSON à mão e commitar depois: a busca roda inteira do outro lado e publica o feed sozinha.

**Nada é agendado.** Nenhum workflow tem `schedule`: tudo só acontece quando você manda, pelo botão **Nova busca** no site ou por **Run workflow** na aba Actions. O gasto com a API fica inteiramente sob seu controle.

**Comece por [docs/DEPLOY.md](docs/DEPLOY.md)** — é o passo a passo para colocar no ar.

---

## Como funciona

```
   GitHub Actions (backend)                    GitHub Pages (interface)
┌───────────────────────────────┐           ┌──────────────────────────────┐
│  só roda quando você manda    │           │  Feed ranqueado e explicado  │
│              ↓                │           │  Critérios editáveis         │
│  10 conectores de vagas       │           │  Decisões (kanban)           │
│              ↓                │           │  CV + carta por vaga         │
│  dedup entre fontes           │           └──────────────┬───────────────┘
│              ↓                │                          │
│  filtros duros + score        │   commit em data/         │ dispara workflow
│              ↓                ├──────────────────────────►│ e salva critérios
│  re-rank semântico (Claude)   │◄─────────────────────────┘  (token do usuário)
│              ↓                │
│  cotas por região → feed.json │
└───────────────────────────────┘
```

### Triagem em dois estágios

1. **Filtros duros e score determinístico** (`pipeline/lib/score.mjs`), sobre 100% das vagas. Barato e rápido. Descarta cidade fora dos critérios, senioridade excluída, foco comercial, vaga antiga e salário abaixo do piso. Pontua cargo, aderência de conteúdo, skills, senioridade, indústria, salário, região e recência.
2. **Re-rank semântico com a Claude** (`pipeline/lib/ai.mjs`), sobre as melhores ~60. Lê a descrição inteira contra o seu perfil e devolve nota, veredito, por que serve, gaps, palavras-chave de ATS que faltam e um sinal de risco. A nota final mistura os dois (35% regras, 65% IA).

Se a chave da API não estiver configurada, ou se um lote falhar, o feed continua saindo com o score determinístico. A IA melhora o resultado; ela não é ponto único de falha.

### Prioridade geográfica

Duas alavancas independentes, ambas editáveis na interface:

- **peso** — quanto a região vale no score de cada vaga (SJRP 1,00 > remoto internacional 0,85 > São Paulo 0,70).
- **cota** — quanto do feed cada região ocupa (55% / 30% / 15%). Se uma região não tiver oferta suficiente, a sobra é preenchida pelas melhores vagas das outras.

São Paulo tem ainda uma **regra de superioridade**: só pontua cheio quando o título é de gerência para cima ou o salário publicado passa de R$ 18 mil. Do contrário perde mais da metade dos pontos de região.

### Estratégia de cargos

Rio Preto é um mercado de porte médio, e mercado menor muda o vocabulário: o que numa multinacional é "Coordenador de Operações" numa empresa de médio porte costuma se chamar "Gerente Administrativo" ou "Supervisor". A lista de cargos em `queries` cobre esse leque — operações, administrativo, projetos, PMO, controladoria, planejamento, processos — em ordem de rendimento esperado, porque as fontes com cota de chamadas cortam a lista pelo começo.

No exterior, `queries_international` busca consultoria (management, business, operations, transformation, implementation, SAP/ERP), que é a continuidade natural do trabalho atual.

Serviços concentram 50,2% do emprego formal em Rio Preto e têm a maior média salarial da cidade, então saúde, cooperativas de crédito e distribuição entram como indústrias prioritárias ao lado de alimentos e serviços financeiros.

### Qual modelo a IA usa

Dois modelos, escolhidos separadamente em **Critérios → Inteligência artificial** (ou em `config/search-profiles.json`):

| Onde | Campo na config | O que faz | Peso no custo |
|---|---|---|---|
| Ranking | `profiles[0].ai_ranking.model` | Lê as ~60 melhores candidatas contra o seu perfil | Alto — é aqui que o dinheiro vai |
| CV e carta | `profiles[0].ai_tailoring.model` | Escreve o material de uma vaga por vez | Baixo — centavos por peça |

As opções e os preços vivem em `ai_pricing_usd_per_mtok`, no mesmo arquivo. A interface monta os dois menus a partir dessa tabela, então **adicionar um modelo novo é adicionar uma linha ali** — nada muda no código. E a tela mostra a estimativa de custo antes de você rodar; a aba **Rodadas** mostra o custo real de cada rodada que já aconteceu.

## Fontes de vagas

| Fonte | Cobertura | Precisa de chave |
|---|---|---|
| Adzuna Brasil | agregador nacional | sim (gratuita) |
| Adzuna US/GB/CA | remoto internacional | mesma chave |
| Jooble Brasil | agregador nacional | sim (gratuita) |
| Remotive, RemoteOK, Arbeitnow, Himalayas | remoto internacional | não |
| Gupy (portal público) | ATS dominante no Brasil | não (best-effort) |
| Greenhouse / Lever / Ashby | páginas de carreira de empresas-alvo | não |
| RSS | alertas de emprego, boards de nicho | não |

Cada fonte é isolada: se uma cair, o relatório da rodada mostra o erro e as outras seguem. `pipeline/diagnose.mjs` testa todas de uma vez.

O LinkedIn **não** é raspado e nenhuma candidatura é enviada automaticamente. A decisão de se candidatar é sempre sua, fora do agente.

## Estrutura

```
app/                 interface (GitHub Pages)
config/
  profile.json       seu CV estruturado — alimenta score semântico, CV e carta
  search-profiles.json  critérios de busca (editáveis pela interface)
  sources.json       conectores ligados/desligados e suas opções
pipeline/
  collect.mjs        orquestrador da rodada
  tailor.mjs         gera CV adaptado e carta de uma vaga
  diagnose.mjs       testa cada fonte
  check.mjs          auto-teste offline (roda no CI antes de tudo)
  lib/               normalização, score, cliente da API da Claude
  sources/           um arquivo por fonte
data/                saída gerada e commitada pelo bot
.github/workflows/   collect, tailor, diagnose — todos manuais
legacy/              versão anterior, mantida para consulta
```

## Comandos locais

```bash
npm run check         # auto-teste offline, sem rede — 70 verificações
npm run collect:dry   # rodada completa sem gravar nada
npm run collect       # rodada completa
npm run diagnose      # testa cada fonte de vagas
npm run tailor <id>   # gera CV e carta de uma vaga
```

Variáveis: `ANTHROPIC_API_KEY`, `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `JOOBLE_API_KEY`.

## Limites conhecidos

- O conector da Gupy usa um endpoint público não documentado. Ele pode quebrar sem aviso; por isso falha isolado, e quando volta vazio o relatório mostra o formato que a API devolveu.
- Erros HTTP carregam o corpo da resposta da API no relatório. Um `400` diz qual parâmetro a API recusou, em vez de virar adivinhação.
- **Rendimento real das fontes** (medido no primeiro diagnóstico): Adzuna e Gupy são as que entregam para cargos de gestão no Brasil; Jooble entrega volume mas com muito comercial; Remotive, RemoteOK e Arbeitnow são boards de engenharia e do mercado alemão e rendem pouco — ficam ligadas porque são gratuitas e custam uma chamada. Se quiser enxugar, desligue-as em `config/sources.json`.
- Os filtros dos conectores usam os **cargos-alvo**, não a lista ampla `must_have_any`. Usar a lista ampla deixava passar qualquer coisa com "manager" no título.
- A conversão de moeda usa taxas fixas em `config/search-profiles.json` (`fx_to_brl`). Ajuste quando o câmbio mudar muito.
- Salário lido do texto da descrição é uma heurística conservadora: na dúvida, o agente marca "salário não divulgado" em vez de chutar.
