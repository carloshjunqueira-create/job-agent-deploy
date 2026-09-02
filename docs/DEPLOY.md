# Como colocar no ar

Sete passos, cerca de 30 minutos — e a maior parte é esperar página de cadastro.

Ordem importa: **1 → 2 → 3** já deixa o site no ar. O **4** liga a IA. O **5** liga as fontes brasileiras. O **6** liga o botão "Nova busca". O **7** é conferência.

> **Nada roda sozinho.** Nenhum workflow tem agendamento: a busca só acontece quando você clica. Se em algum momento quiser voltar a agendar, basta acrescentar um bloco `schedule` em `.github/workflows/collect.yml`.

---

## 1. Subir o código para o GitHub

Os arquivos já estão prontos e testados em `C:\Documentos\job-research-agent`. Falta levá-los ao repositório.

### Caminho recomendado: GitHub Desktop (sem terminal)

Subir arquivo por arquivo pelo navegador funciona, mas tem duas armadilhas: a pasta `.github` **não sobe por arrastar** (o navegador ignora pastas que começam com ponto), e é fácil esquecer um arquivo e deixar o repositório num estado meio-atualizado que quebra de um jeito confuso. O GitHub Desktop resolve os dois: ele compara as pastas e mostra exatamente o que mudou antes de você confirmar.

1. Baixe em <https://desktop.github.com/> e entre com sua conta.
2. **File → Clone repository → GitHub.com →** `job-application-agent`. Escolha uma pasta nova, por exemplo `C:\Documentos\job-agent-repo`.
3. Copie **todo o conteúdo** de `C:\Documentos\job-research-agent` para dentro de `C:\Documentos\job-agent-repo`, substituindo o que já existir. No Explorer: Ctrl+A, Ctrl+C na origem, Ctrl+V no destino, "Substituir os arquivos no destino".
4. Volte ao GitHub Desktop. A aba **Changes** lista tudo o que mudou — dá para clicar em cada arquivo e ver a diferença.
5. Escreva o resumo do commit e clique em **Commit to main**, depois em **Push origin**.

A partir da segunda vez, só os passos 3 a 5.

### Alternativa: PowerShell

Se o git já estiver instalado (teste com `git --version`):

```powershell
cd C:\Documentos
git clone https://github.com/carloshjunqueira-create/job-application-agent.git job-agent-repo
cd job-agent-repo
robocopy C:\Documentos\job-research-agent . /E /XD .git
git add -A
git commit -m "v3.3: cargos ampliados, filtros ajustados"
git push
```

> `robocopy` termina com código 1 ou 3 quando copia arquivos — isso é sucesso. Só 8 ou acima é problema.

### Se for mesmo subir pelo navegador

Dá para fazer, mas siga esta ordem para não quebrar nada: suba primeiro `config/`, `pipeline/`, `app/`, `data/`, `docs/` e os arquivos da raiz num único commit (**Add file → Upload files**, arrastando as pastas juntas). Depois, para cada arquivo em `.github/workflows/`, use **Actions → New workflow → set up a workflow yourself** e cole o conteúdo. São três arquivos: `collect.yml`, `tailor.yml`, `diagnose.yml`.

Um detalhe que passa despercebido: o arquivo `.nojekyll` na raiz é vazio e o navegador às vezes se recusa a enviá-lo. Ele existe para o GitHub Pages não processar o site como blog. Se sumir, o site continua funcionando — só recrie pelo **Add file → Create new file** com o nome `.nojekyll` e conteúdo vazio se algo parecer estranho.

## 2. Ligar o GitHub Pages

No repositório: **Settings → Pages**.

- **Source**: `Deploy from a branch`
- **Branch**: `main`, pasta `/ (root)`
- **Save**

Em 1 a 2 minutos o site fica em:

```
https://carloshjunqueira-create.github.io/job-application-agent/
```

A raiz redireciona para `/app/`, que é a interface. Nesse momento o feed ainda está vazio — normal.

> Se a página carregar sem estilo, force um recarregamento com **Ctrl + F5**. A versão anterior tinha um service worker que guardava a interface antiga em cache; a v3 traz um que se autodestrói, mas o primeiro carregamento pode precisar do empurrão.

## 3. Dar permissão de escrita ao Actions

Os workflows precisam commitar o feed de volta no repositório.

**Settings → Actions → General → Workflow permissions** → marque **Read and write permissions** → **Save**.

Sem isso a rodada roda, mas o commit final falha.

## 4. Chave da Anthropic (a IA do ranking, do CV e da carta)

1. Entre em <https://console.anthropic.com/> → **API Keys** → **Create Key**. Copie a chave (ela só aparece uma vez).
2. Coloque crédito em **Billing**. US$ 10 já cobrem bastante tempo de uso.
3. No repositório: **Settings → Secrets and variables → Actions → New repository secret**
   - **Name**: `ANTHROPIC_API_KEY`
   - **Secret**: a chave copiada

**Custo real, por unidade de uso** (não há mensalidade porque nada roda sozinho):

| Ação | Haiku 4.5 | Sonnet 5 | Opus 5 |
|---|---|---|---|
| Uma busca completa (60 vagas na IA) | ~US$ 0,15 | ~US$ 0,30 | ~US$ 0,74 |
| Um CV + carta gerado | ~US$ 0,04 | ~US$ 0,04 | ~US$ 0,11 |

Rodando três buscas por semana com Sonnet e gerando cinco materiais por mês, dá algo perto de **US$ 4 por mês**. Os US$ 10 de crédito duram bastante.

A tela mostra a estimativa antes de você rodar, e a aba **Rodadas** mostra o custo real de cada rodada que já aconteceu. Se quiser gastar zero numa rodada específica, marque **Rodar sem IA** no modal de busca.

Sem esse secret o feed continua saindo, mas só com o score de regras — sem veredito, sem gaps, sem CV nem carta.

### Qual modelo escolher

Em **Critérios → Inteligência artificial** há dois menus, porque as duas tarefas têm economias diferentes:

- **Modelo do ranking** — lê 60 vagas por rodada. É onde o custo se concentra. `claude-sonnet-5` é a escolha padrão: separa bem "vaga de coordenação de operações" de "vaga comercial disfarçada", que é exatamente o julgamento que você precisa. `claude-haiku-4-5-20251001` corta o custo pela metade e ainda entrega um ranking decente — bom para quando você quiser varrer muito.
- **Modelo do CV e da carta** — roda um texto por vez, quando você clica. Custa centavos mesmo no modelo mais caro, então aqui vale usar `claude-opus-5`: é o texto que uma pessoa vai ler para decidir se te chama.

Uma combinação que faz sentido: **Haiku no ranking, Opus na carta**. Você varre barato e escreve bem.

Os modelos e preços vêm da tabela `ai_pricing_usd_per_mtok` em `config/search-profiles.json`. Quando a Anthropic lançar um modelo novo, adicione uma linha lá e ele aparece nos dois menus — não precisa mexer no código.

## 5. Chaves das fontes brasileiras

São as duas fontes que cobrem vagas no Brasil por API. Ambas gratuitas.

### Adzuna (cobre Brasil e internacional)

1. <https://developer.adzuna.com/> → **Sign up** → confirme o e-mail.
2. O painel mostra **Application ID** e **Application Key**.
3. Crie dois secrets no repositório:
   - `ADZUNA_APP_ID`
   - `ADZUNA_APP_KEY`

Plano gratuito: cerca de **1.000 chamadas por mês**. Cada busca consome ~30 chamadas (8 cargos × 2 cidades no Brasil, mais 5 cargos × 3 países no exterior), então dá para umas **30 buscas por mês**. Se quiser mais fôlego, reduza `max_queries` em `config/sources.json`.

### Jooble

1. <https://br.jooble.org/api/about> → peça a chave gratuita (chega por e-mail, normalmente no mesmo dia).
2. Crie o secret `JOOBLE_API_KEY`.

Enquanto essas chaves não existirem, o pipeline pula essas fontes e o relatório da rodada avisa `PULADA — secrets ausentes`. As fontes internacionais (Remotive, RemoteOK, Arbeitnow, Himalayas) e a Gupy funcionam sem chave nenhuma.

## 6. Token para o botão "Nova busca" funcionar

O site é estático: para ele disparar uma busca e salvar critérios, precisa de um token seu. Fica guardado **só no seu navegador**.

1. GitHub → foto do perfil → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Preencha:
   - **Token name**: `job-agent`
   - **Expiration**: 90 dias (ou o que preferir — vai precisar renovar depois)
   - **Repository access**: **Only select repositories** → `job-application-agent`
   - **Permissions → Repository permissions**:
     - **Actions**: `Read and write`
     - **Contents**: `Read and write`
3. **Generate token** e copie.
4. Abra o site → botão **Conectar** → cole o token e o repositório (`carloshjunqueira-create/job-application-agent`) → **Salvar e testar**. Deve aparecer "Conectado a …" em verde.

**Sobre segurança**: o token dá acesso de escrita só a esse repositório, que é público e não tem nada sensível. Ele fica no `localStorage` do navegador — não é enviado a nenhum servidor além da própria API do GitHub. Ainda assim: não use esse token em computador compartilhado, e o botão **Remover token** apaga na hora. Se preferir não usar token, tudo continua funcionando pelo botão **Run workflow** na aba **Actions**; você só perde o disparo pela própria página e o salvamento de critérios pela interface (nesse caso o botão **Salvar critérios** baixa o JSON para você subir à mão).

## 7. Primeira rodada e conferência

Na ordem:

1. **Actions → Diagnóstico das fontes → Run workflow.** Não usa a API da Anthropic, então não custa nada. Em 1 a 2 minutos o resumo mostra, fonte por fonte, `OK`, `PULADA` ou `ERRO` — e agora o erro traz o corpo da resposta da API, dizendo qual parâmetro foi recusado.
2. **Actions → Buscar vagas → Run workflow.** Deixe os campos em branco. Ao terminar, o resumo traz o funil (coletadas → únicas → passaram nos filtros → publicadas), o desempenho de cada fonte, o custo estimado em dólares e o motivo de cada descarte.
3. Abra o site e recarregue. O feed deve estar preenchido.
4. Ajuste em **Critérios** o que estiver fora do lugar e salve. A próxima rodada já usa.

A partir daí, sempre que quiser um feed novo: botão **Nova busca** no site (ou **Run workflow** no GitHub). Nada roda sem você mandar.

---

## Antes de usar de verdade: revise seu perfil

`config/profile.json` está marcado como `RASCUNHO_GERADO_AUTOMATICAMENTE_REVISAR`. Ele foi montado com o que já estava registrado sobre você, e é ele que alimenta o julgamento da IA, o CV adaptado e a carta.

O que mais vale corrigir, em ordem de impacto:

1. **`experience[].highlights`** — trocar descrição de atividade por resultado. "Sustentou PMO de programa SAP" é fraco; "Sustentou PMO de programa SAP S/4HANA com 8 frentes e X usuários, entregando go-live no prazo" é o que faz a IA acertar a nota e a carta ficar concreta.
2. **Datas e cargos** de Instituto Sonho Grande, Burger King e Unilever, que estão vazios.
3. **`identity.linkedin`** — o link do seu perfil.
4. **`constraints.notice_period`** e **`travel_availability`**, que hoje estão em branco.

Quanto mais específico esse arquivo, melhor tudo o que sai do outro lado. É o único trabalho manual que sobrou no sistema.

---

## Quando algo der errado

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Workflow falha em "Publicar o feed" | Actions sem permissão de escrita | Passo 3 |
| Fonte marcada `PULADA` | secret da chave não existe | Passos 4 e 5 |
| Fonte marcada `ERRO` | endpoint mudou ou está fora do ar | Veja a mensagem no resumo; desligue a fonte em `config/sources.json` (`"enabled": false`) até ajustar |
| Feed vazio mas o workflow passou | filtros apertados demais | Baixe o score mínimo e aumente a idade máxima em **Critérios** |
| Botão "Nova busca" diz que não está conectado | token ausente ou expirado | Passo 6 |
| Site carrega com layout antigo | cache do service worker anterior | **Ctrl + F5** |
| "Bad credentials" ao conectar | token expirado ou sem permissão | Gere outro com Actions e Contents em read/write |
| Rodada gasta mais token que o esperado | muitas vagas indo para a IA | **Critérios → Vagas enviadas à IA por rodada**, reduza de 60 para 30, ou troque o modelo do ranking para Haiku |
| Adzuna com `HTTP 400` | parâmetro recusado pela API | Já corrigido nesta versão (`content_type` e `what_phrase` saíram). Se voltar, a mensagem de erro agora diz qual parâmetro é |
| Gupy retorna 0 vagas | formato da resposta mudou | O relatório mostra as chaves que a API devolveu; ajuste `pipeline/sources/gupy.mjs` ou desligue a fonte |
| Feed com vaga claramente errada | filtro deixou passar | Marque **Não** no card (ela some e não volta) e, se for um padrão, acrescente o termo em **Critérios → Exclusões** |

O comando `npm run check` roda 70 verificações offline da lógica de triagem e é executado pelo próprio workflow antes de qualquer coleta — se ele falhar, a rodada para antes de gastar chamada de API.
