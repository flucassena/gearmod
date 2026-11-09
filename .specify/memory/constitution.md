# Constituição — GearMod

App desktop Electron (Windows 10/11 x64, Linux x64 e macOS 12+) que entrega cards de um kanban a agentes de programação (Claude Code, Codex, Gemini), cada card na sua worktree Git. Monorepo pnpm em TypeScript strict: `apps/desktop` (main em `src/main`, preload em `src/preload`, renderer React em `src/renderer/src`) e `packages/contracts` (tipos e esquemas Zod compartilhados). Estas regras protegem a fronteira de segurança entre a interface, o sistema e os agentes, os dados do usuário e a consistência da interface.

## Princípios

### I. Renderer só fala com o main pelo contrato Zod (inegociável)
- O renderer **DEVE** chamar o main só por `window.gearmod.invoke` (e `onRunEvent`), com o canal declarado em `ipcContracts` de `@gearmod/contracts`.
- **NÃO DEVE** usar `ipcRenderer`, `require('electron')` ou módulos do Node no renderer. As janelas **DEVEM** manter `contextIsolation: true`, `nodeIntegration: false` e `sandbox: true`.
- Canal novo **DEVE** ter entrada e saída em Zod (`.strict()` nos objetos, limites em strings e listas) e teste no main.
- Caminho vindo do renderer **DEVE** passar pelas checagens do main (`allowedPath`, `trashablePath`) antes de ler, escrever ou apagar.

**Por quê:** o contrato é o que confere os dois lados e impede que a interface (que mostra conteúdo de agentes) acesse o sistema direto.

### II. Agentes recebem o mínimo e nunca veem segredos (inegociável)
- O ambiente de processo de agente **DEVE** ser montado por `buildEnv` (`env-policy.ts`). **NÃO DEVE** repassar `process.env` inteiro.
- Segredo (token, senha, chave) **DEVE** ficar no `SecretStore` (armazenamento criptografado do sistema). **NÃO DEVE** ir para o SQLite, para logs ou para o contexto do agente.
- Texto de agente ou de comando que vai para disco, log ou tela **DEVE** passar por `redact`.
- Commit feito por agente **DEVE** passar pela verificação de segredos (`secret-scan.ts`).
- Ação arriscada pedida por agente **DEVE** passar pelo `ApprovalService`.

**Por quê:** o agente roda código no computador do usuário; vazar uma credencial ou deixar o agente agir sem permissão não tem volta.

### III. Nada do usuário se perde sem querer (inegociável)
- Excluir arquivo ou pasta do usuário **DEVE** mandar para a Lixeira (`shell.trashItem`). Exceção: pastas temporárias do próprio app.
- Ação destrutiva ou que descarta edição **DEVE** pedir confirmação com `ConfirmDialog` (`danger`) dizendo o que se perde.
- Push forçado **DEVE** usar `--force-with-lease`. **NÃO DEVE** usar `--force` em push.
- SQL destrutivo na página de banco **DEVE** passar por `sql-danger` (confirmação na tela e defesa no main).

**Por quê:** o usuário confia projetos, branches e bancos ao app; um erro aqui apaga trabalho dele.

### IV. Migração de banco é nova, numerada e imutável (inegociável)
- Mudança no esquema do SQLite **DEVE** ser uma migração nova em `migrations.ts`, com a próxima `version` e um `checksum` próprio.
- **NÃO DEVE** alterar uma migração já publicada (o app recusa abrir com checksum diferente).
- Migração **DEVE** preservar os dados existentes e ter teste.

**Por quê:** o usuário atualiza instalando por cima e os dados continuam; uma migração reescrita quebra quem já tem o banco.

### V. Texto da interface passa pelo i18n
- Texto visível, dicas, `aria-label` e mensagens **DEVEM** vir dos dicionários: `useT()` em componentes, `tr()` fora deles (renderer), `tm()` no main. Chave nova **DEVE** existir em `pt-BR` e `en` (o pt-BR é a fonte do tipo).
- **NÃO DEVE** haver texto de usuário fixo no código.
- A tela **NÃO DEVE** depender do texto de uma mensagem: use um código de `error-codes.ts` (`withErrorCode`/`errorCodeOf`).
- Botão de confirmação **DEVE** dizer a ação ("Excluir", "Descartar"), não "OK" ou "Sim".
- Prompts e skills enviados aos agentes **DEVEM** ser em inglês e indicar o idioma de saída pelo `idioma`. Eles não entram nos dicionários.

**Por quê:** o app tem dois idiomas; texto fixo aparece no idioma errado e tela que lê texto quebra quando a tradução muda.

### VI. Erro de ação do usuário aparece para ele, em linguagem simples
- Falha de uma ação que o usuário pediu **DEVE** aparecer: `toast.error` ou mensagem no próprio diálogo, com o texto passado por `plainError`.
- **NÃO DEVE** engolir o erro de uma ação do usuário com `catch(() => undefined)`. Isso só é aceito em leituras de fundo opcionais (selo, contagem).
- **NÃO DEVE** mostrar `String(error)` cru ("Error invoking remote method…").

**Por quê:** clicar e nada acontecer é o pior caso; e a mensagem técnica do Electron não diz nada ao usuário.

### VII. Diálogos seguem um formato só
- Confirmação **DEVE** usar `ConfirmDialog`; aviso com um botão, `NoticeDialog`. **NÃO DEVE** usar `window.confirm`, `window.alert`, `window.prompt` nem o diálogo nativo do Electron para isso.
- Modal **DEVE** ter `.overlay > .modal`, `role="dialog"` (ou `alertdialog`) e `aria-label`; `header` com `.eyebrow` e `h2`; botões em `.actions`, com Cancelar (`.secondary`) primeiro e a ação principal por último (`.danger` / `.danger.solid` se destrutiva).
- Modal **DEVE** fechar com Esc pelo `useEscape` (Esc cancela, nunca confirma, e não fecha o que está por trás).

**Por quê:** o diálogo nativo não segue o tema e trava a janela; modal feito à mão acaba com teclado diferente em cada tela.

### VIII. Controles, dicas e cores vêm dos componentes e do tema
- Lista de escolha **DEVE** usar `Select` / `MultiSelect`; caixa de seleção, `Checkbox`; liga/desliga, `Switch`; escolha exclusiva descrita, linhas `.ck-line.pickrow`. **NÃO DEVE** haver `<select>` ou checkbox nativo solto.
- Estado de carregamento de painel, página ou corpo de diálogo **DEVE** usar `Loading` (mascote pensando e texto com pontos animados, `label` para dizer o que carrega). **NÃO DEVE** ser um texto solto como "Carregando…". Botão e texto curto em linha continuam com o texto simples.
- Campo de texto **DEVE** usar a classe `in` e ter rótulo (`label.f` ou `aria-label`).
- Dica **DEVE** usar `data-tip` (mostrado pelo `TooltipLayer`). **NÃO DEVE** usar o atributo `title` nativo em elemento HTML. Botão só com ícone **DEVE** ter `data-tip` e `aria-label`.
- Cor **DEVE** vir das variáveis de `prototype.css` / `theme-tokens.css` ou de classes que as usam. **NÃO DEVE** haver `#hex` ou `rgb()` em `style` inline. Exceção: dados que são a própria cor (paleta de agentes, amostras de tema, cor escolhida).
- Cor fixa nova em CSS **DEVE** ter a variante de `:root[data-theme="light"]`.

**Por quê:** controles nativos e `title` ignoram o tema e o idioma; com um componente só, ajustar o visual é um lugar só.

### IX. Comportamento novo vem com teste
- Mudança de comportamento no main, nos contratos ou em lógica pura do renderer **DEVE** ter teste Vitest no arquivo `*.test.ts` ao lado do código.
- Teste de Git e SDD **DEVE** rodar contra um repositório real numa pasta temporária (`mkdtemp` + `git init`), como os testes existentes.
- Correção de bug **DEVE** vir com teste que falhava antes da correção, quando der para reproduzir.
- `typecheck`, `lint` (zero avisos) e `test` **DEVEM** passar.

**Por quê:** o app mexe em repositórios e dados do usuário; regressão aqui só aparece no computador dele.

## Restrições

- Plataformas: Windows 10/11 x64, Linux x64 (AppImage e `.deb`) e macOS 12+ (Apple Silicon e Intel, em preview). Mudança **NÃO DEVE** quebrar o build nem o comportamento de nenhuma delas; o CI empacota as três.
- Lógica que muda por plataforma **DEVE** ficar numa função que recebe o `platform` como parâmetro (quem chama passa `process.platform`, como em `mac.ts`, `title-bar.ts` e `shell-path.ts`), para ser testada em qualquer sistema, com o caso de cada plataforma no teste.
- Caminho, separador de PATH, shell e terminal **NÃO DEVEM** ser assumidos do Windows: usar `path.join`/`delimiter`, e no Linux e no macOS o PATH do shell de login do usuário (`shell-path.ts`).
- Atalho de teclado **DEVE** usar Cmd no macOS e Ctrl nas outras plataformas (pela tabela de `shortcuts.ts`), e módulo nativo novo **DEVE** ser compilado para o Electron em todos os pacotes.
- Tudo roda local: sem servidor nem conta do GearMod. **NÃO DEVE** haver telemetria ou envio de dados do usuário para serviço do GearMod. Chamadas externas só para o que o usuário configurou (CLIs de agente, GitHub/GitLab, Groq, bancos).
- Dependência nova empacotada no app **DEVE** ter licença compatível com a PolyForm Shield e entrar no `THIRD-PARTY-NOTICES.md` (`pnpm notices`).
- `src/main/generated/` é gerado por `scripts/generate-codex-types.mjs` e **NÃO DEVE** ser editado à mão.

## Domínio, produto e operação

- O checkout principal do usuário **NÃO DEVE** ser alterado pelo trabalho de um card: o agente trabalha na worktree do card.
- Integração com o Spec Kit **DEVE** respeitar a versão máxima suportada (`specKitUpdateCeiling` em `specKitUpdates.ts`) e não reinstalar nem sobrescrever o que o projeto já tem em `.specify/`.
- Atualizar instalando por cima e desinstalar **NÃO DEVEM** apagar os dados do usuário (`%APPDATA%\GearMod` no Windows, `~/.config/GearMod` no Linux, `~/Library/Application Support/GearMod` no macOS).
