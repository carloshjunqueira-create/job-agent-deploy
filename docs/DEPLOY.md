# Como colocar no ar

Sete passos. Do zero ao feed rodando sozinho leva cerca de 30 minutos, e a maior parte é esperar página de cadastro.

Ordem importa: **1 → 2 → 3** já deixa o site no ar. O **4** liga a IA. O **5** liga as fontes brasileiras. O **6** liga o botão "Nova busca". O **7** é conferência.

---

## 1. Subir o código para o GitHub

Os arquivos novos estão em `C:\Documentos\job-research-agent`. Essa pasta **não é um clone do repositório**, então o caminho mais seguro é clonar o repositório em outro lugar, copiar os arquivos por cima e dar push.

No **PowerShell** (Windows):

```powershell
# 1. clone o repositório em uma pasta nova
cd C:\Documentos
git clone https://github.com/carloshjunqueira-create/job-application-agent.git job-agent-deploy
cd job-agent-deploy

# 2. copie os arquivos novos por cima
robocopy C:\Documentos\job-research-agent . /E /XD .git

# 3. confira o que mudou
git status

# 4. commit e push
git add -A
git commit -m "v3: pipeline automatico no GitHub Actions, feed com IA e criterios editaveis"
git push
```

> `robocopy` termina com código 1 ou 3 quando copia arquivos — isso é sucesso, não erro. Só códigos 8 ou acima são problema.

Se preferir não usar terminal: abra o repositório no GitHub, use **Add file → Upload files** e arraste as pastas `app`, `config`, `pipeline`, `data`, `docs` e os arquivos `index.html`, `package.json`, `README.md`, `.nojekyll`. A pasta `.github` **não sobe por arrastar** no navegador (o GitHub esconde pastas que começam com ponto) — para ela, use o `git push` acima ou crie os workflows pelo botão **Actions → New workflow → set up a workflow yourself**, colando o conteúdo de cada arquivo.

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

**Custo esperado**: com `claude-sonnet-5` e duas rodadas por dia, algo em torno de **US$ 10 a 12 por mês**. Se quiser cortar para uns US$ 3 a 4, troque o modelo para `claude-haiku-4-5-20251001` no painel **Critérios → Inteligência artificial** do próprio site.

Sem esse secret o feed continua saindo, mas só com o score de regras — sem veredito, sem gaps, sem CV nem carta.

## 5. Chaves das fontes brasileiras

São as duas fontes que cobrem vagas no Brasil por API. Ambas gratuitas.

### Adzuna (cobre Brasil e internacional)

1. <https://developer.adzuna.com/> → **Sign up** → confirme o e-mail.
2. O painel mostra **Application ID** e **Application Key**.
3. Crie dois secrets no repositório:
   - `ADZUNA_APP_ID`
   - `ADZUNA_APP_KEY`

Plano gratuito: cerca de 1.000 chamadas por mês. As duas rodadas diárias cabem com folga.

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

**Sobre segurança**: o token dá acesso de escrita só a esse repositório, que é público e não tem nada sensível. Ele fica no `localStorage` do navegador — não é enviado a nenhum servidor além da própria API do GitHub. Ainda assim: não use esse token em computador compartilhado, e o botão **Remover token** apaga na hora. Se preferir não usar token, tudo continua funcionando pelo cron e pelo botão **Run workflow** na aba **Actions**; você só perde o disparo pela página e o salvamento de critérios pela interface (nesse caso o botão **Salvar critérios** baixa o JSON para você subir à mão).

## 7. Primeira rodada e conferência

Na ordem:

1. **Actions → Diagnóstico das fontes → Run workflow.** Em 1 a 2 minutos o resumo mostra, fonte por fonte, `OK`, `PULADA` ou `ERRO` com a mensagem. É aqui que se descobre qual endpoint precisa de ajuste — os conectores foram escritos a partir da documentação pública, mas nunca foram executados contra a rede.
2. **Actions → Buscar vagas → Run workflow.** Deixe os campos em branco. Ao terminar, o resumo traz o funil (coletadas → únicas → passaram nos filtros → publicadas), o desempenho de cada fonte, o gasto de tokens e o motivo de cada descarte.
3. Abra o site e recarregue. O feed deve estar preenchido.
4. Ajuste em **Critérios** o que estiver fora do lugar e salve. A próxima rodada já usa.

A partir daí ele roda sozinho às 9h e às 19h (horário de Brasília), de segunda a sexta.

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
| Rodada gasta mais token que o esperado | muitas vagas indo para a IA | **Critérios → Vagas enviadas à IA por rodada**, reduza de 60 para 30 |

O comando `npm run check` roda 40 verificações offline da lógica de triagem e é executado pelo próprio workflow antes de qualquer coleta — se ele falhar, a rodada para antes de gastar chamada de API.
