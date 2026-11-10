# Design system do GearMod

Objetivo: cada peça visual que se repete (chip, contagem, nota, cartão de opção, botão, mensagem, ponto de status, nível de complexidade) tem **uma** aparência, em qualquer tela. A Constituição (princípio VIII, `.specify/memory/constitution.md`) manda seguir este guia.

- Código: `apps/desktop/src/renderer/src/design-system.css`, importado em `main.tsx` logo depois de `prototype.css`.
- Galeria: `docs/design-system.html` mostra tudo no tema escuro e no claro, lado a lado, com o CSS real do app. Para abrir, sirva a raiz do repositório (`python -m http.server 8765`) e acesse `http://127.0.0.1:8765/docs/design-system.html`.

## Tema x design system

| | Tema (`theme-tokens.css`, `:root` do `prototype.css`, personalização) | Design system (`design-system.css`) |
|---|---|---|
| Decide | as cores brutas: superfícies, texto, acento, `--blue`, `--ok`, `--warn`, `--danger`, `--danger-solid`, `--plan` | o que cada **estado** usa e com qual receita |
| Quem muda | o usuário (claro/escuro, acento, cores personalizadas) | só o código |

O design system nunca define hex: aponta para as cores do tema. Assim os dois temas e qualquer acento continuam funcionando, sem regra extra em `:root[data-theme="light"]`.

## Tons

| Token | Vem de | Quando usar |
|---|---|---|
| `--tone-neutral` | `--muted` | rótulo sem estado, "mantido", "verificando" |
| `--tone-info` | `--blue` | informação, **IA: recomendação (✦) e botões de IA**, "atual", item novo para ler, tipo feature, prioridade média |
| `--tone-success` | `--ok` | concluído, salvo, conectado, aprovado, **escolhido pelo usuário**, risco resolvido, **melhorou** (pontuação caiu), etapa de execução |
| `--tone-warning` | `--warn` | atenção, pausado, parado, aguardando o usuário, difere do recomendado, conflito, alteração não salva, risco novo, voltou de etapa, etapa de teste, prioridade alta |
| `--tone-danger` | `--danger` | erro, **falhou** (sempre), risco, desconectado, ação destrutiva, pontuação que subiu, prioridade urgente, tipo bug |
| `--tone-plan` | `--plan` | **modo plano** e etapa de planejamento (roxo). Não é a IA: IA é info |

Níveis de complexidade reaproveitam os tons: `--lv-simple` = success, `--lv-medium` = warning, `--lv-complex` = danger.

Variação de pontos (pontuação ou dimensão entre versões) é sempre `▲n` em perigo (subiu) e `▼n` em sucesso (desceu), pelo `deltaText` de `Assessment.tsx`; nunca `+n` / `−n`.

### Receitas

| Token | Valor | Para quê |
|---|---|---|
| `--tone-<tom>` | a cor | texto, ícone, ponto, borda lateral de destaque |
| `--tone-<tom>-bg` | tom 9% sobre `--surface-2` (neutro: `--surface-3`) | fundo suave de chip, nota, banner |
| `--tone-<tom>-line` | tom 40% sobre transparente (neutro: `--border`) | borda de chip, nota, botão; anel de foco inválido |
| `--tone-<tom>-fill` | tom 16% sobre `--surface-2` | fundo de controle preenchido: botão, pill do card, hover de menu |
| `--tone-<tom>-count` | tom 32% sobre `--surface-2` | bolinha atrás de um número (texto `--text`) |
| `--tone-danger-solid` | `--danger-solid` | botão de confirmação destrutiva (`.danger.solid`), texto branco |
| `--tone-tint` / `--tone-edge` / `--tone-fill` / `--tone-count` | 9% / 40% / 16% / 32% | ajustar a receita num lugar só |


## Classes

Toda peça `.ds-*` começa neutra; acrescente `.tone-info`, `.tone-success`, `.tone-warning`, `.tone-danger` ou `.tone-plan` para colorir. A classe de tom só define variáveis (`--tone`, `--tone-bg`, `--tone-line`), então funciona em qualquer peça.

| Classe | Para quê | Exemplo |
|---|---|---|
| `.ds-chip` (`.sm`) | estado ou rótulo curto em pílula; `<i>` opcional vira um ponto. Só dois tamanhos: normal 11.5px e `.sm` 10.5px | `<span class="ds-chip tone-success"><i></i>Aprovado</span>` |
| `.ds-count` | número dentro de chip, aba ou botão | `<span class="ds-count tone-danger">3</span>` |
| `.ds-dot` | marcador de legenda ou luz de status | `<i class="ds-dot tone-warning"></i>` |
| `.ds-note` | aviso de uma ou duas linhas; `<b>` e `.ds-note-i` ficam na cor do tom | `<div class="ds-note tone-info"><span class="ds-note-i">✦</span><span><b>Recomendação da IA</b> — …</span></div>` |
| `.ds-note.block` | aviso de várias linhas ou com lista no corpo de um diálogo ("o que se perde") | `<div class="ds-note block tone-danger" role="alert"><b>…</b><ul>…</ul></div>` |
| `.tone-text` | texto ou ícone na cor do tom (linha de status, `.dot` que usa `currentColor`) | `<small class="tone-text tone-danger">Falhou</small>` |
| `.ds-panel` + `.ds-panel-title` | seção de um diálogo, com título pequeno em caixa alta | |
| `.ds-legend` | linha de "marcador + texto" explicando cores | |
| `.ds-opt` (ou `.cx-opt`) | cartão de escolha. `.on` = escolhido pelo usuário (success); `.rec` = recomendado pela IA (info, com ✦) | |
| `.ds-aimark` (ou `.cx-aimark`) | o ✦ da IA no canto do cartão recomendado; `.ds-aimark.inline` no meio do texto | |
| `.ds-status` | ícone de status (pipeline, job, check) no tom do estado com `.tone-text.tone-*`: passou success, falhou danger, rodando info, manual warning, pendente/cancelada neutro (`StatusIcon` em `prUi.tsx`) | `<span class="ds-status tone-text tone-success"><StatusSuccessIcon/></span>` |
| `.ds-spin` | algo rodando ("rodando", "Comentando…"). Gira a caixa em volta do ícone, nunca o `<svg>` (o `svg.ico` tem `transform-box: view-box` e o Chromium gira fora do centro); `--ds-phase` (delay negativo pelo relógio, fixado quando aparece) mantém o giro no lugar quando a tela redesenha (`Spinner` em `prUi.tsx`) | `<span class="ds-spin"><StatusRunningIcon/></span>` |

Classes que já existiam e seguem o sistema (use-as em vez de criar outra):

| Peça | Classe |
|---|---|
| Botão destrutivo | `.danger` (grande), `.danger.solid` (confirmação final), `.mini.danger` (pequeno), `.ib.stop` (parar agente), `.trashbtn` (lixeira) |
| Botão que pede resposta | `.mini.ask`, `.badge.ask` |
| Notificação | `.ntoast.success/.error/.warning/.info` (`toast.*`) |
| Mensagem de erro | `.error` (bloco), `.cx-error`, `.ch-error`, `.hint.err`, `.term-error`, `.fv-note.err` (linha) |
| Aviso | `.smallnote`, `.pw-warn`, `.cx-note.warn`, `.cfl-banner`, `.wf-banner` |
| Pill do card | `.pill.feature` (info), `.pill.bug` / `.pill.urgent` (danger), `.pill.high` / `.pill.minor` (warning) |
| Status de conexão | `.agstatus.on/.off`, `.settings-agent-status.on/.off`, `.teamdot.on/.off`, `.db-dot.ready`, `.ws-dot.ready` |
| Pendência | `.pendot`, `.ydot`, `.tab-dot`, `.gear-dot` (warning) |
| Contagem | `.ds-count`, `.cx-count` (neutra), `.cx-vrisks i`, `.cx-sum-risks i` (`--tone-danger-count`) |
| Plano | `.badge.plan`, `.modechip`, `.mode`, `.dot-plan`, `.card.planopen`, `.tile.plan`, `[data-step=planning]` |
| IA | `.cx-airec`, `.cx-aimark`, `.cgai`, `.gwai` (info) |
| Complexidade | `.cx-badge`, `.cx-score`, `.cx-sum`, `.cx-lbar .seg`, `.sbar-track` com `.simple/.medium/.complex` |

## Regras

1. Cor de estado sempre por tom: **nada** de `#hex`, `rgb()`, `--cf-*`/`--cb-*`/`--cl-*` nem as cores brutas do tema (`--warn`, `--danger`, `--blue`, `--ok`, `--plan`) fora de `design-system.css`. No TSX, use classe (`.tone-text.tone-*`, `.ds-*`) em vez de `style={{ color }}`; mapa de cor por valor (tipo, prioridade) aponta para `var(--tone-*)`.
2. Mesmo significado, mesmo tom em todas as telas: "escolhido por você" e "melhorou" são sempre success; IA é sempre info com ✦; falhou, risco e erro são sempre danger; pausado, parado e aguardando são sempre warning; plano é sempre plan.
3. Use as receitas: fundo suave `-bg`, borda `-line`, controle preenchido `-fill`, número `-count`. Não invente porcentagem nova numa regra solta; se precisar de outra, crie o token aqui.
4. Chip só em dois tamanhos (11.5px ou 10.5px). Variável que não existe no tema não vale: nada de `var(--line, #3a3a42)`; use `--border`, `--surface-2` etc. sem cor reserva.
5. Peça nova que se repete: classe `.ds-*` em `design-system.css`, linha neste guia e exemplo na galeria, no mesmo commit.
6. Classe antiga: troque só as cores pelos tokens (sem mudar tamanho), como nas migrações abaixo, e apague a regra `:root[data-theme="light"]` que corrigia a cor no claro.
7. Fora do sistema, de propósito (paletas de domínio, não estados): diff e status de arquivo do Git (`.gdl-row`, `.gdiffbody`, `.st.A/M/D`, `.nums`, `.ch-add/.ch-del`, `.cb-add/.cb-del`, `.gref.head`), realce de sintaxe (`.tok-*`), tipos de arquivo (`.filetype.*`), avatares e cores de agente, cores de tipo de card escolhidas pelo usuário, mudanças na grade do banco (`.db-grid`) e amostras de tema.

## Ícones

- **Todo ícone mora em `icons.tsx`** (a família do banco em `DbIcons.tsx`; tipos de arquivo em `FileAppearance.tsx`). Não escreva `<svg>` dentro do componente: crie o ícone lá com `make(desenho, { box })` e importe.
- **Padrão visual** (`design-system.css`, seção 4, classe `.ico` que o `make` põe): desenho de linha, pontas e cantos arredondados, sem preenchimento (só pontinhos, com `dot()`), e traço de `--icon-stroke` (1.5px) igual em qualquer tamanho e grade. A tela escolhe só tamanho e cor (`color` ou `stroke`); espessura e preenchimento não mudam por contexto.
- **Tamanho aparente igual**: forma (card, pasta, lixeira, lupa…) ocupa 75% da caixa (18 de 24, como o Lucide); seta de navegação 58%; X, +, ✓, setinhas e pontinhos ficam no tamanho do Lucide. Desenhe na grade 24; um desenho que veio de outra grade é enquadrado com `view` no `make` (medido com `getBBox`), não redesenhado.
- **O significado de cada ícone fica escrito** no comentário de uma linha acima dele em `icons.tsx` ("Close or hide a panel, chat, file, reply or notice."). O catálogo mostra esse texto e só alerta quando um ícone é usado para mais de uma coisa sem significado escrito.
- **Um ícone por significado, um significado por ícone**: a mesma ação usa o mesmo ícone em todas as telas, e um ícone não é reaproveitado para outra coisa só porque "parece".
  - IA = `SparkIcon` (✦); plano = `PlanIcon`; novo chat = `ChatPlusIcon`; abrir card = `CardIcon`; worktree = `TreeIcon` (árvore), branch/Git = `BranchIcon`; token de acesso = `KeyIcon`, consumo do agente = `TokenIcon`; arquivos alterados = `DiffIcon`; expandir/recolher = `ExpandIcon`/`CollapseIcon`; setas só para abrir/fechar e navegar.
- A galeria tem o catálogo gerado do código (seção "Ícones"): onde cada desenho é usado e para quê, com os desenhos repetidos e os significados desenhados de mais de um jeito. Depois de mexer em ícones, gere de novo:

  ```bash
  node scripts/design-system-icons.mjs
  ```

## Histórico da migração

**Rodada 1** (avaliação, chat e decisões): `.cx-chip`, `.cx-sum-tag`, `.cx-sum-risks`, `.cx-sum-score small b`, `.cx-vtag`, `.cx-vlatest`, `.cx-vdelta`, `.cx-vrisks`, `.cx-rkchip`, `.cx-rk`, `.cx-rkn`, `.cx-rkgone`, `.cx-rkcount`, `.cx-note.warn`, `.cx-airec`, `.cx-aimark`, `.cx-aispark`, `.cx-legend i`, `.cx-flowhint`, `.cx-opt.on/.rec` (a opção recomendada no chat passou de acento para info + ✦), `.wfc-chip`, `.sbar-track`, `.cx-status`, `.decside-list li`, `.mini.danger`, `.mini.ask`, `.pw-chip`, `.tset-chip`, `.ch-step`, `.cxside-rows b.ok`, `.tasks-badge.bad`. `--ok` passou a existir no tema.

**Rodada 2** (resto do app): `.danger`, `.danger.solid` (`--danger-solid`), `.ib.stop`, `.trashbtn`, `.iconremove`, `.iconpick-error`, `.ctxitem.danger`, `.q-menu button.danger`, `.pr-opt.danger`, `.error`, `.wf-error`, `.ch-error`, `.ch-log`, `.term-error`, `.hint.err`, `.tasks-*` (falha/concluído), `.voicecard.err`, campos inválidos (`.wf-findbox.invalid`, `.titlein.invalid`, `.titlein-err`), `.repo-x:hover`, `.gwcount.over`, `.pill.*`, `.badge.paused/.ask`, `.agchip.paused`, `.card.paused`, `.smallnote`, `.pw-warn`, `.cfl-banner`, `.cfl-target`, `.gtab-conflict`, `.wf-banner`, `.tab-dot`, `.agupdate`, `.pendot`, `.ydot`, `.cgpol .pd`, `.cgamend`, `.cx-warn`, `.mcp-tags em.warn`, `.mcp-note`, `.perm-risk`, `.perm-steps li`, `.wf-state`, `.pcfg-save-state.saved`, `.agstatus`, `.settings-agent-status`, `.teamdot`, `.proc-state.done`, `.ch-repo`, `.dbtest.ok`, `.db-cico.ready`, `.db-tb.ok/.danger`, `.db-dot`, `.ws-dot`, `.db-hist-dot`, `.sel-opt.hl`, `.pw-vm-ok`, `.pw-vm-note.warn`, `.micbtn.on`, `.ch-new`, `.cx-lbar .seg` (agora nas cores de nível). Saíram as correções do tema claro de `.wf-state`, `.agstatus`, `.wf-error` e `.gtab-conflict`.

**Rodada 3** (revisão): notificações (`.ntoast`) nos tons; "falhou" sempre perigo (status do card no chat, alertas do projeto, tarefas em segundo plano, conta Git com problema, `.cx-error`); "melhorou" sempre sucesso (`.cx-delta`, `.cx-pop-delta`, `.cx-pill`, linha do tempo); tom `--tone-plan` para o modo plano; botões de IA do Git (`.cgai`, `.gwai`) em info; etapas (`[data-step]`) e `.cx-return` nos tons; `.wsdel` e `.cleanup-risk` na receita de perigo; contagens com `--tone-*-count`; `--line` (que não existia) trocado por `--border` e cores reservas removidas; todo `var(--warn|--danger|--blue|--ok)` do `prototype.css` virou `--tone-*`; tamanhos de chip unificados; TSX sem cor de estado inline (`CardChat`, `CardEditor`, `WorktreeDelete`).
