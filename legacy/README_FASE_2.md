# Fase 2 — Feed de decisão

O feed está em `app/` e usa `jobs/phase2_feed.json` como fila. A proporção atual é 12 vagas de São José do Rio Preto e 3 de São Paulo (80/20), sem preencher a fila com vagas fora das cidades permitidas.

## Nova busca pelo navegador

O fluxo recomendado agora não exige terminal para montar uma nova rodada:

1. Abra `app/` no site e clique em **Nova busca**.
2. Informe o nome da família, ajuste cargos/indústrias se necessário e use os links de pesquisa pública por cidade.
3. Use **Copiar briefing** para pedir a coleta em fontes públicas. Solicite que o retorno venha no formato `phase1_scored_jobs.json`, com `scoring.fit_score` e `scoring.opportunity_score` em cada vaga.
4. Importe o arquivo ou cole o JSON na área **Vagas coletadas e pontuadas**.
5. Clique em **Gerar feed no navegador**. A página mostra a prévia imediatamente, preserva candidaturas/vagas fechadas e permite baixar o novo `phase2_feed.json`.
6. Envie o arquivo baixado para `jobs/phase2_feed.json` no GitHub para publicar a rodada.

O site não coleta automaticamente vagas nem executa buscas autenticadas: os links e o briefing aceleram a coleta pública, enquanto a geração, filtragem e organização do feed acontecem no próprio navegador. O CV não é exposto no site; por isso o arquivo importado deve chegar já pontuado.

## Gerar automaticamente uma nova família

Depois de coletar e pontuar as vagas, o gerador transforma o resultado diretamente no formato consumido pela aplicação. Ele aplica as cidades permitidas, a proporção geográfica, o piso salarial, o corte mínimo de aderência, a exclusão de prospecção/vendas e a regra de superioridade para São Paulo. Também preserva vagas marcadas como `APPLIED` ou `CLOSED` e identifica URLs de página de empresa.

Dentro de `job-agent/`, execute:

```bash
node engine/build_phase2_feed.js \
  --input jobs/phase1_scored_jobs.json \
  --output jobs/phase2_feed.json \
  --family "nome da nova família" \
  --limit 15
```

Por padrão, o gerador lê o `jobs/phase2_feed.json` anterior para reaproveitar estados `APPLIED` e `CLOSED` quando uma vaga reaparece. Use `--previous-feed outro_feed.json` para indicar outro histórico ou `--no-previous-feed` para começar sem reaproveitamentos.

Para uma família específica, mantenha os arquivos de origem separados:

```bash
node engine/score_jobs.js \
  --input jobs/phase1_gestao_operacoes_alimentos_real.json \
  --output jobs/phase1_gestao_operacoes_alimentos_scored.json

node engine/build_phase2_feed.js \
  --input jobs/phase1_gestao_operacoes_alimentos_scored.json \
  --output jobs/phase2_feed.json \
  --preferences config/search_preferences.json \
  --family "gestão de operações em alimentos"
```

O comando imprime um relatório com vagas consideradas, selecionadas e excluídas por localidade, salário, aderência ou foco comercial. A coleta das vagas ainda precisa vir de fontes públicas; o gerador automatiza a triagem e a montagem do feed, não o acesso autenticado ao LinkedIn nem a candidatura.

## Fluxo de decisão

- **Me candidatei** registra a candidatura no histórico e retira a vaga da fila.
- **Tenho interesse** registra intenção para acompanhamento, sem enviar candidatura.
- **Salvar** mantém a vaga na fila e a coloca no histórico de salvas.
- **Não tenho interesse**, **Vaga fechada** e **Link não é da vaga** registram o motivo e retiram a vaga da fila.
- Links para `/company/` são identificados como página da empresa e exibem um alerta antes da decisão.

O registro é local, por navegador/dispositivo. Nenhum botão acessa uma conta, faz scraping autenticado ou envia candidatura ao LinkedIn: a pessoa sempre confirma a candidatura fora do agente.

## Ajuste dos critérios

Use **Ajustar busca** no topo para editar cargos, indústrias, cidades e proporções, mínimo/alvo salarial e exclusões. Os ajustes são salvos no navegador. **Copiar ajustes** gera um JSON para orientar a preparação do próximo `phase2_feed.json`; a página estática não coleta novas vagas sozinha.

## Uso local

A partir de `job-agent/`, execute:

```bash
python3 -m http.server 4173
```

Depois abra `http://localhost:4173/app/`.

As decisões ficam no armazenamento local do navegador. O agente não faz login, não envia candidaturas e não armazena credenciais ou cookies.

## Estados já registrados

- MoveEdu: candidatura já realizada.
- Rodobens: removida por foco em prospecção/vendas.
- Bradesco: removida por encerramento das candidaturas.
- EY: removida após correção da localização para Rio de Janeiro.
- Hortolândia e demais cidades: removidas do feed.
