# Job Application Agent - Fase 1

## Objetivo

Esta fase cria o motor que recebe vagas padronizadas, compara cada vaga com o perfil de Carlos e devolve:

- `fit_score` de 0 a 100;
- `opportunity_score`, combinando aderência e urgência;
- componentes do score;
- evidências encontradas;
- gaps ou pontos para confirmar;
- faixa de recomendação;
- versão de CV sugerida.

## Arquivos

- `config/scoring_rules.json`: pesos, aliases, regras de salário, localização, urgência e seleção de CV.
- `jobs/phase1_real_jobs.json`: amostra de 20 vagas públicas coletadas em 01/09/2026 para benchmark.
- `engine/score_jobs.js`: motor executável em Node.js.
- `engine/build_phase2_feed.js`: gera automaticamente o feed da Fase 2 a partir do resultado pontuado.
- `app/feed-builder.js`: versão do gerador que roda diretamente no navegador, sem terminal.
- `jobs/phase1_scored_jobs.json`: saída gerada após a execução.

## Como executar

Abra o terminal na pasta `job-agent` e execute:

```bash
node engine/score_jobs.js --input jobs/phase1_real_jobs.json --output jobs/phase1_scored_jobs.json
```

O resultado será salvo em `jobs/phase1_scored_jobs.json`.

## Como interpretar

- `fit_score`: aderência estrutural ao perfil.
- `opportunity_score`: prioriza vagas recentes sem ignorar aderência.
- `salary_confirmation_required: true`: salário não foi divulgado; a vaga não é descartada automaticamente.
- `application_eligibility: BLOCKED_BY_SALARY`: salário publicado abaixo de R$15.000 CLT; não permitir candidatura.
- `gaps`: requisitos publicados sem evidência suficiente no perfil ou sinais que exigem confirmação.
- `suggested_cv`: versão conceitual do CV a ser criada na fase de currículos.

## Limite desta fase

O benchmark usa páginas públicas e snippets. A vaga deve ser verificada novamente antes de qualquer candidatura, pois status, descrição, salário e prazo podem mudar. O motor não acessa conta autenticada, não armazena credenciais e não executa candidaturas.
