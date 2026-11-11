<div align="center">

# GearMod

**Espaço de desenvolvimento com vários agentes**

*Shift gears. Build faster.*

[![Baixar para Windows](https://img.shields.io/badge/Baixar-Windows%20x64-2563eb?style=for-the-badge&logo=windows)](https://github.com/flucassena/gearmod/releases/latest)

[![CI](https://github.com/flucassena/gearmod/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/flucassena/gearmod/actions/workflows/ci.yml)
[![Licença: PolyForm Shield 1.0.0](https://img.shields.io/badge/licen%C3%A7a-PolyForm%20Shield%201.0.0-555)](LICENSE.md)
![Plataforma: Windows 10/11, Linux x64 e macOS (prévia)](https://img.shields.io/badge/plataforma-Windows%2010%20%7C%2011%20%7C%20Linux%20x64%20%7C%20macOS%20(pr%C3%A9via)-555)

[English](README.md) · **Português**

</div>

O GearMod é um app desktop que transforma o seu trabalho em cards num quadro kanban e entrega cada card a um agente de programação, como o **Claude Code** ou o **Codex**. Cada card roda na sua própria worktree Git, então os agentes trabalham em paralelo sem mexer no seu checkout principal, e você revisa, commita e faz merge na mesma janela.

Tudo roda na sua máquina. O GearMod usa as CLIs de agente que você já tem e não tem servidor nem conta próprios.

![O quadro do GearMod com cards em Backlog, To do, Doing, Test e Done](.github/assets/board.png)

## Recursos

**Planeje antes de o agente escrever código**
- Cada card tem resumo, especificação, plano e lista de tarefas, escritos com o agente num chat de planejamento.
- Planejamento, implementação e teste são etapas separadas, cada uma com seu chat, agente, modelo e modo de permissão.
- Fluxos guiados por especificação, inclusive projetos com [Spec Kit](https://github.com/github/spec-kit), e uma Constituição do projeto que todo agente segue.

**Agentes com segurança, lado a lado**
- Uma worktree e uma branch por card, com o nome do tipo do card (`feature/…`, `fix/…`, `improvement/…`).
- Os agentes recebem um ambiente mínimo em vez do seu ambiente completo, e ações arriscadas perguntam antes.
- Vários agentes trabalham ao mesmo tempo; o GearMod mostra o que cada um está fazendo e quantos tokens usou.

**Revise e entregue num só lugar**
- Uma página Git embutida, com o grafo de commits, diffs, conflitos resolvidos bloco a bloco, rebase, stash e pull requests para GitHub e GitLab.
- Editor, terminal e explorador de arquivos ao lado do quadro, com a worktree do card como pasta de trabalho.
- Uma verificação que bloqueia commits de agente com chaves ou senhas inconfundíveis.

**Ferramentas para os agentes**
- Um servidor MCP local deixa os agentes ler e atualizar o card, fazer perguntas e pedir commits.
- Um índice de código local oferece busca de símbolos e "quais testes esta mudança afeta" (veja [Índice de código](#índice-de-código)).
- Skills globais ou por projeto, escolhidas com `/` em qualquer chat.

**Extras opcionais**
- Ditado por voz (whisper.cpp local ou Groq), gerenciador de PostgreSQL (experimental) e Playwright CLI para o agente de teste.

![Um card com especificação, plano e tarefas](.github/assets/card.png)

## Instalação

**Requisitos**
- Windows 10 ou 11, 64 bits, ou Linux x64 com ambiente gráfico (testado no Ubuntu 22.04 ou mais novo). O macOS 12 ou mais novo está em prévia: os pacotes são gerados, mas ainda não foram testados por usuários.
- [Git](https://git-scm.com/downloads).
- Pelo menos uma CLI de agente instalada e logada: [Claude Code](https://docs.claude.com/en/docs/claude-code) ou [Codex](https://github.com/openai/codex).

**Passos no Windows**
1. Abra a [última versão](https://github.com/flucassena/gearmod/releases/latest) e baixe o `GearMod-Setup-<versão>-x64.exe`.
2. Rode o instalador. Ele instala só para o seu usuário e não precisa de administrador.
3. O instalador ainda não é assinado, então o SmartScreen do Windows pode mostrar **"O Windows protegeu o computador"**. Clique em **Mais informações** e depois em **Executar assim mesmo**.
4. Abra o GearMod pelo menu Iniciar.

Para conferir o download, compare o hash com o `SHA256SUMS.txt` da mesma versão:

```powershell
Get-FileHash .\GearMod-Setup-<versão>-x64.exe -Algorithm SHA256
```

Para atualizar, instale a versão nova por cima da antiga; seus dados continuam. Para desinstalar, use **Configurações › Aplicativos** do Windows. Desinstalar não apaga seus dados.

**Passos no Linux (x64)**

A [última versão](https://github.com/flucassena/gearmod/releases/latest) traz dois pacotes para Linux; escolha um.

- **`.deb` (Debian, Ubuntu e derivados):** baixe o `GearMod-<versão>-amd64.deb` e instale com:

  ```sh
  sudo apt install ./GearMod-<versão>-amd64.deb
  ```

  O GearMod aparece no menu de aplicativos. Para atualizar, instale o `.deb` novo do mesmo jeito; para desinstalar, rode `sudo apt remove gearmod`.
- **AppImage (qualquer distribuição):** baixe o `GearMod-<versão>-x86_64.AppImage` e rode:

  ```sh
  chmod +x GearMod-<versão>-x86_64.AppImage
  ./GearMod-<versão>-x86_64.AppImage
  ```

  Se der erro de FUSE (`libfuse.so.2`), instale o `libfuse2` (`sudo apt install libfuse2t64` no Ubuntu 24.04, `sudo apt install libfuse2` no 22.04) ou abra com `./GearMod-<versão>-x86_64.AppImage --appimage-extract-and-run`.

Para conferir o download, deixe-o na mesma pasta do `SHA256SUMS.txt` da mesma versão e rode:

```sh
sha256sum -c SHA256SUMS.txt --ignore-missing
```

O GearMod guarda segredos (chaves de API, tokens) no cofre do sistema, então o Linux precisa do **gnome-keyring** ou do **KWallet** rodando. Sem um deles, o GearMod abre, mas recusa salvar segredos e explica o motivo. Entrar, instalar ou atualizar uma CLI de agente abre uma janela de terminal (o seu `$TERMINAL`, ou o primeiro encontrado entre `x-terminal-emulator`, GNOME Terminal, Konsole, Xfce Terminal, kitty, Alacritty e xterm).

**Passos no macOS (prévia)**

1. Abra a [última versão](https://github.com/flucassena/gearmod/releases/latest) e baixe `GearMod-<versão>-arm64.dmg` (Apple Silicon: M1 ou mais novo) ou `GearMod-<versão>-x64.dmg` (Intel).
2. Abra o `.dmg` e arraste o GearMod para **Aplicativos**.
3. O app ainda não é notarizado pela Apple, então o macOS bloqueia a primeira abertura (diz que o GearMod "está danificado" ou "não pode ser aberto"). Rode isto uma vez no Terminal e depois abra o GearMod normalmente:

   ```sh
   xattr -dr com.apple.quarantine /Applications/GearMod.app
   ```

Para conferir o download, rode `shasum -a 256 -c SHA256SUMS.txt --ignore-missing` na pasta com o `.dmg` e o `SHA256SUMS.txt`. Para atualizar, baixe o `.dmg` novo e substitua o app em Aplicativos; seus dados são mantidos. Entrar, instalar ou atualizar uma CLI de agente abre uma janela do Terminal. O GearMod lê o PATH do seu shell (zsh por padrão), então as CLIs instaladas com Homebrew, npm ou nvm são encontradas.

## Primeiros passos

1. **Adicione um projeto.** Clique em **New project** e escolha um ou mais repositórios Git.
2. **Adicione um agente.** Em **Settings › Agents**, cadastre a CLI do Claude Code ou do Codex que você já usa. O GearMod detecta as CLIs instaladas e a conta em que cada uma está logada.
3. **Crie um card.** Descreva o que você quer. O chat de planejamento ajuda a escrever a especificação, o plano e as tarefas.
4. **Inicie o card.** O GearMod cria a worktree e a branch, e o agente implementa as tarefas. Responda às perguntas e aprove as ações arriscadas quando aparecerem.
5. **Teste e revise.** Rode a etapa de teste, leia o diff na página Git, depois commite e abra um pull request.

## Um card do começo ao fim

As capturas desta seção vêm de uma execução real: três cards num app de exemplo de finanças pessoais ("Ledgerly", Angular + Supabase), planejados, implementados e testados pelo Codex dentro do GearMod. A interface aparece em inglês.

| Card | Nota | Fluxo |
| --- | --- | --- |
| Saldos negativos em vermelho no painel | 3, simples | Fluxo curto |
| Exportar compras para CSV | 15, médio | Spec leve |
| Orçamento mensal por categoria (tabela nova, segurança por linha, página nova) | 24, complexo | SDD completo |

**1. Planeje.** Abra o chat de planejamento do card e peça ao agente para planejá-lo. Nessa etapa o agente só lê o código, nunca altera. Ele explora o código primeiro, dá a nota de complexidade do card e propõe um fluxo. As perguntas dele aparecem como opções no chat, e a troca de fluxo espera a sua aprovação. No card SDD, o agente ainda fez três perguntas de produto antes de escrever o plano: o que conta como gasto, o que acontece com limites que já existem ao copiar, e quais categorias podem ter orçamento.

![O chat de planejamento recomenda o SDD completo e pergunta qual fluxo usar](.github/assets/flow-choice.png)

**2. Leia os documentos.** O plano fica salvo no card como documentos Markdown, com histórico de versões: resumo, especificação, plano (com plano de teste) e tarefas. O fluxo curto guarda só uma nota curta de "o que fazer". Você pode editar qualquer documento antes de iniciar.

![O plano do card SDD, com contexto técnico, checagem de princípios e decisões](.github/assets/card-plan.png)

**3. Implemente.** Ao iniciar o card, o GearMod cria a worktree e a branch dele (`feature/monthly-budgets-per-category-…`). O agente de implementação segue as tarefas e marca cada uma no painel lateral; os arquivos alterados aparecem abaixo delas. No fim, o agente pede para commitar, e você autoriza, edita a mensagem ou nega.

![O chat de implementação com as seis tarefas concluídas e o agente pedindo para commitar](.github/assets/card-execution.png)

**4. Teste.** A etapa de teste usa um agente separado, com checklist próprio. Ele registra o que passou e o que não conseguiu conferir. Aqui ele rodou 5 testes, com 90 combinações de filtro, e um build de produção. Também avisou que o download num navegador de verdade ficou sem conferir, porque o Playwright não estava configurado.

![O chat de teste com o checklist](.github/assets/card-test.png)

**5. Revise e faça o merge.** Os commits de cada card aparecem na página Git, marcados com o card. De lá você lê os diffs, faz o merge ou abre um pull request.

## Como o GearMod escolhe o fluxo

Nem todo card precisa de uma especificação completa. O GearMod dá uma nota a cada card e recomenda um fluxo, e a escolha final é sua.

**A nota.** O agente de planejamento avalia o card de 0 a 3 em seis dimensões:

| Dimensão | Peso padrão |
| --- | --- |
| Escopo | 2 |
| Acoplamento | 2 |
| Incerteza | 2 |
| Risco | 3 |
| Novidade técnica | 1 |
| Dificuldade de validação | 1 |

O total é a soma de nota × peso; com os pesos padrão, o máximo é 33. Cada nota vem com justificativa e evidências: arquivos com número de linha, o commit analisado ou a sua própria mensagem.

![O diálogo de avaliação: 24 pontos, complexo, com justificativa por dimensão](.github/assets/flow-assessment.png)

**A recomendação.**

| Total (limites padrão) | Nível | Fluxo recomendado |
| --- | --- | --- |
| 0–7 | Simples | **Fluxo curto**: um agente implementa e valida a partir de uma descrição curta. Não há documento de especificação, plano ou tarefas, nem etapa de teste separada. |
| 8–16 | Médio | **Spec leve**: uma especificação curta com critérios de aceite, um plano e tarefas. |
| 17 ou mais | Complexo | **SDD completo**: especificar, esclarecer, planejar (com plano de teste), tarefas, verificar, resumo. |

Um card com risco 3 nunca recebe o fluxo curto como recomendação; sobe pelo menos para spec leve. Pesos (0–5) e limites podem ser mudados por projeto em **Project settings › Workflow**.

![Pesos das dimensões e limites dos níveis nas configurações do projeto](.github/assets/flow-weights.png)

**A sua decisão.**
- O agente registra a nota com `gearmod_assess_complexity` e propõe o fluxo com `gearmod_choose_workflow`. A proposta é um pedido de aprovação. Nada muda até você responder.
- Você pode escolher outro fluxo; o card mostra quando a sua escolha difere da recomendação.
- Você pode contestar as notas. Isso cria uma nova versão da avaliação, marcada como correção sua.
- As avaliações têm versões e nunca são sobrescritas. Uma avaliação *preliminar* é feita antes de o agente explorar o código. Cada versão nova mostra o *delta* em relação à anterior.
- O SDD completo usa o método do próprio GearMod ou o [Spec Kit](https://github.com/github/spec-kit). O Spec Kit exige que o projeto esteja configurado para ele e, nesse caso, usa as próprias skills.
- Todo agente segue a Constituição do projeto (`.gearmod/constitution.md`, ou `.specify/memory/constitution.md` no Spec Kit).
- Cada card guarda um registro de decisões e evidências (`history.jsonl`) e um `discovery.md` com a tabela de notas.

## Gerenciador de Git

A visão **Git** é um cliente Git completo, organizado em torno dos cards.

![A página Git: grafo de commits com branches e worktrees por card](.github/assets/git-graph.png)

- **Grafo:** grafo de commits com rótulos de branch local, remota, tag e worktree. Commits feitos por agentes levam o ícone do agente e o card a que pertencem.
- **Uma branch e uma worktree por card:** cada card trabalha na própria pasta e branch, e o seu checkout principal nunca é tocado. A barra lateral lista branches (agrupadas por prefixo), worktrees, pull requests e stashes.
- **Painel do card:** mostra a branch base e a branch do card em cada repositório, commits à frente e atrás, e arquivos não commitados. Dali você commita (com mensagem sugerida), faz push, abre um PR em rascunho ou apaga a worktree.
- **Mudanças e diffs:** stage e unstage por arquivo, descartar, stash de um só arquivo, adicionar ao `.gitignore` e amend. Os diffs abrem para arquivos em edição e para qualquer commit, e dá para editar o arquivo no próprio diff.
- **Branches e commits:** checkout, merge, rebase, cherry-pick, revert, reset, renomear commit, criar branch ou tag. Pull e push com fetch, fast-forward e rebase. Um push recusado oferece pull, pull com rebase ou push forçado. A maioria das operações pode ser desfeita e refeita.
- **Conflitos:** resolva conflitos de merge, rebase, cherry-pick, revert e stash bloco a bloco. Em cada bloco, aceite o atual, o que chega ou os dois; ou pegue o arquivo inteiro de um lado. Depois continue ou aborte.
- **Commits de agente pedem permissão:** a regra de commit do projeto decide se os agentes commitam livremente, se pedem antes ou se nunca commitam. As regras podem ser definidas por branch. Por padrão os agentes pedem, e nunca commitam em `main`, `develop` ou `release/*`. Uma verificação de segredos bloqueia commits de agente com chaves ou senhas inconfundíveis.
- **Pull requests:** no GitHub e no GitLab você lista, lê (descrição, revisões, comentários, diff), comenta, aprova ou pede mudanças (GitHub) e cria PRs.
- **Contas e tokens:** em **Project settings › Git**, defina um token por host para o projeto, com substituição opcional por repositório. O token nunca é mostrado de novo depois de salvo.

## Gerenciador de banco de dados (experimental)

Um cliente PostgreSQL dentro do projeto, para conferir os dados que os cards alteram. Vem ligado; defina `GEARMOD_DATABASE_EXPERIMENTAL=0` para escondê-lo.

![A visão de banco: árvore de conexões, uma aba SQL e uma tabela com paginação](.github/assets/database.png)

- **Conexões:** um servidor pode ter vários bancos. Cada conexão tem uma classe (`dev`, `test`, `prod`, `external`). Qualquer host que não seja local conta como `external`.
- **Escrita é uma chave por conexão:** `dev` e `test` começam com escrita, `prod` e `external` começam só leitura. Ligar a escrita em `prod` ou `external` pede que você digite o nome do banco.
- **No editor SQL**, `DROP`, `TRUNCATE`, e `DELETE`/`UPDATE` sem `WHERE` pedem confirmação.
- **Senhas:** guardadas criptografadas, ou mantidas só durante a sessão.
- **Árvore e abas:** servidor › banco › schema › tabelas, views e sequências, com busca. As abas de SQL e de tabela podem ser divididas e reorganizadas.
- **SQL:** rode com Ctrl+Enter e cancele com Esc. O resultado mostra até 1.000 linhas, com tempo e contagem de linhas. Toda consulta fica num histórico.
- **Tabelas:** filtre com `WHERE` e `ORDER BY` (com autocompletar), ordene por coluna, pagine de 10 a 1.000 linhas por vez e peça a contagem exata quando quiser. Em conexões com escrita, dá para editar células, adicionar ou excluir linhas, ver o SQL gerado e então aplicar.
- Os agentes ainda não usam essas conexões.

## Índice de código

O GearMod mantém um mapa local do código do projeto: funções, classes, chamadas, imports e testes. Os agentes consultam o mapa antes de abrir arquivos, então leem menos para achar o código certo. O editor também usa o mapa.

![A seção do índice de código nas configurações do projeto](.github/assets/code-index.png)

- **Ligado por padrão, por projeto:** desligue em **Project settings › General**; aí os agentes voltam à busca de texto e à leitura de arquivos.
- **Local:** fica em `code-index/index.sqlite`, na pasta de dados do GearMod. Indexa cada pasta do projeto e a worktree de cada card.
- **Como é montado:** o código é lido com tree-sitter, num processo em segundo plano. Arquivos sem mudança são reaproveitados, e arquivos alterados são reindexados quando você salva. Pastas como `node_modules`, `dist`, `build` e `.venv`, e arquivos acima de 1 MB, ficam de fora.
- **Linguagens:** TypeScript, JavaScript, Python, Go, Java, C#, Rust, PHP, Ruby e C/C++.
- **Ferramentas dos agentes:**
  - `gearmod_code_explore` responde a uma pergunta ou lista de nomes com o código relevante, caminhos de chamada, dependentes e testes.
  - `gearmod_code_node` mostra um símbolo com quem o chama e o que ele usa.
  - `gearmod_code_search` acha símbolos pelo nome.
  - `gearmod_code_impact` lista tudo que usa um símbolo e os testes a rodar.
  - `gearmod_code_affected_tests` lista os testes que dependem dos arquivos que você mudou.
- **Atalhos no editor:** Ctrl+T (ir para símbolo), Ctrl+Shift+O (estrutura do arquivo), F12 (definição) e Shift+F12 (referências).

## Como funciona

```
Card ──► Worktree Git + branch ──► CLI do agente (Claude Code / Codex)
  ▲                                            │
  └──────── Servidor MCP (card, perguntas, commits) ◄┘
```

- **Worktrees:** cada card tem sua pasta e sua branch, então vários agentes trabalham ao mesmo tempo sem atrapalhar uns aos outros nem o seu checkout principal.
- **Seus agentes, suas contas:** o GearMod abre as CLIs que você instalou, com o seu login e o seu plano. Ele não intermedeia nem revende acesso a modelos.
- **Ponte MCP:** os agentes falam com o GearMod por um servidor MCP local para atualizar o card, fazer perguntas e pedir commits.

## Seus dados

Tudo fica na sua máquina, em `%APPDATA%\GearMod` no Windows, `~/.config/GearMod` no Linux ou `~/Library/Application Support/GearMod` no macOS: o banco SQLite, os anexos, os backups e as worktrees dos cards. O GearMod não envia nada para lugar nenhum. Recursos opcionais só usam a rede quando você os liga; o [SECURITY.md](SECURITY.md) lista quais são.

O GearMod **não é uma sandbox**: os agentes rodam com as permissões do seu usuário, dentro do modo de permissão escolhido. Leia o [SECURITY.md](SECURITY.md) para ver o que é e o que não é garantido.

## Perguntas frequentes

**O GearMod é open source?**
O GearMod é **source-available** (código disponível), sob a [PolyForm Shield License 1.0.0](LICENSE.md). Você pode ler, usar, modificar e redistribuir o código, inclusive dentro de uma empresa, mas não pode usá-lo para oferecer um produto que concorra com o GearMod. Não é uma licença open source aprovada pela OSI.

**Custa alguma coisa?**
O GearMod é gratuito. Os agentes usam o seu próprio plano do Claude ou da OpenAI.

**Funciona no macOS ou no Linux?**
O Linux x64 é suportado (veja os passos de instalação acima). Os pacotes do macOS estão em prévia: são gerados em toda versão, mas ainda não foram testados por usuários.

**Quais agentes são suportados?**
Claude Code e Codex. O suporte ao Gemini CLI existe, mas está desativado por enquanto.

**Posso contribuir?**
Pull requests de fora ainda não são aceitos; relatos de bug e sugestões são bem-vindos. Veja o [CONTRIBUTING.md](CONTRIBUTING.md).

## Compilar a partir do código

Você precisa de Node.js 22+, pnpm 11+ e Git no Windows.

```powershell
pnpm install      # também recompila o better-sqlite3 para o Electron
pnpm dev          # roda o app em modo de desenvolvimento
pnpm typecheck
pnpm lint
pnpm test
```

Gerar um executável ou o instalador:

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1       # apps/desktop/dist/win-unpacked/GearMod.exe
powershell -ExecutionPolicy Bypass -File .\installer.ps1   # apps/desktop/dist/GearMod-Setup-<versão>-x64.exe
```

Os dois scripts fecham o `GearMod.exe` aberto da pasta `win-unpacked`, porque ele trava a pasta. Os testes trocam o binário nativo do `better-sqlite3` entre Node e Electron, então não rode os testes com o app aberto da mesma pasta. Use `GEARMOD_DATA_DIR` para rodar com uma pasta de dados descartável.

As versões são geradas pelo GitHub Actions: enviar uma tag como `v0.2.0` (igual à versão de `apps/desktop/package.json`) gera o instalador do Windows, os pacotes do Linux e as imagens de disco do Mac e os publica com os checksums. O que uma versão traz vai em `release-notes/<versão>.md`, que abre as notas da Release, com o texto em português em `release-notes/<versão>.pt-BR.md`. A página de download mostra os dois.

```
apps/desktop        App Electron (processo principal, preload, interface React)
packages/contracts  Tipos compartilhados e contratos de IPC (Zod)
scripts             Scripts de manutenção (avisos de terceiros, tipos do protocolo do Codex)
spike               Experimentos do índice de código (gera as consultas do tree-sitter)
```

## Contribuição

O GearMod ainda não aceita pull requests de fora: todas as mudanças são feitas pelo mantenedor. Relatos de bug e sugestões são bem-vindos como [issues](https://github.com/flucassena/gearmod/issues) ou por e-mail para sena.franciscolucas@gmail.com. Veja o [CONTRIBUTING.md](CONTRIBUTING.md).

## Licença e marcas

- Código: [PolyForm Shield License 1.0.0](LICENSE.md) (vale o texto em inglês). Veja também o [NOTICE](NOTICE).
- Os pacotes de terceiros mantêm suas licenças; veja o [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- O nome e o logo GearMod não estão cobertos pela licença do código; veja o [TRADEMARKS.md](TRADEMARKS.md).
- Claude Code, Codex e outros nomes de produtos pertencem aos seus donos. O GearMod não tem vínculo com a Anthropic nem com a OpenAI.
