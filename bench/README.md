# Benchmark do índice de código

Mede quanto o índice de código do GearMod reduz o custo de agentes de programação (Claude Code e Codex) ao responder perguntas e fazer pequenas mudanças. A comparação é feita contra o agente sem índice e contra outras ferramentas (CodeGraph, codebase-memory-mcp, Serena e o mapa do Aider), em vários repositórios. É a base experimental do TCC.

Tudo roda na sua máquina. Os agentes usam o seu login do Claude e do Codex e gastam do seu plano ou da sua API.

## Onde ficam os dados

Só o código e a documentação do benchmark ficam no repositório. Os dados ficam fora dele, em `../bench-data` (ao lado da pasta do repositório), para nunca entrarem num commit:

| Pasta | Conteúdo |
| --- | --- |
| `bench-data/work/` | Clones dos outros repositórios, cópias, índices, mapas e logs |
| `bench-data/results/` | Execuções, transcrições, notas e análise |
| `bench-data/questions/` | Catálogos de perguntas e gabaritos (descrevem o código de outros repositórios) |

Para usar outra pasta, defina `BENCH_DATA`. O benchmark não entra no build do app (o instalador só leva `apps/desktop/out` e `resources/`) nem no site (o GitHub Pages publica só `site/`).

## Peças

| Arquivo | O que faz |
| --- | --- |
| `servers/gearmod-index.ts` | O índice de produção (`apps/desktop/src/main/code-index`) fora do app: servidor MCP, indexação e exportação de arestas |
| `build.mjs` | Empacota o servidor em `apps/desktop/.bench/` (roda com o Electron do app como Node) |
| `prepare.mjs` | Baixa os repositórios no commit fixado, remove `CLAUDE.md`/`AGENTS.md` e o gabarito, cria cópias para ferramentas que escrevem no projeto |
| `run.mjs` | Executa um experimento: pergunta × ferramenta × agente × repetição, em ordem aleatória com semente, com retomada |
| `score.mjs` | Corrige as respostas: regex do gabarito, juiz opcional (modelo) e amostra para revisão humana |
| `export.mjs` | Junta tudo em `results/_dataset/runs.csv` e `toolcalls.csv` |
| `analysis/analyze.py` | Estatística: comparações pareadas, modelo misto, não inferioridade, ablação, classificador, escala, padrões de uso |
| `analysis/power.py` | Análise de poder: quantas perguntas e repetições são necessárias |
| `oracle/ts-oracle.mjs` | Precisão e cobertura das arestas do índice contra o compilador TypeScript |
| `perf.mjs` | Tempo de indexação (do zero, sem mudança, segunda worktree, um arquivo editado) |
| `draft-questions.mjs` | Rascunha perguntas e gabarito com um agente **sem** o índice, para revisão humana |
| `check-drafts.mjs` | Segunda opinião de outro modelo sobre cada fato do rascunho, e um `review.md` só com o que precisa de atenção |
| `promote-drafts.mjs` | Aplica as correções e leva os rascunhos para o catálogo (`--approve` depois da sua leitura) |
| `validate.mjs` | Confere o catálogo: estrutura, regex e se cada arquivo:linha citado existe |
| `config/` | Repositórios, ferramentas, agentes, preços e textos fixos dos prompts |
| `bench-data/questions/<repo>.json` | Catálogo de perguntas com gabarito (fora do repositório) |
| `experiments/*.json` | Os blocos do estudo |

## Passo a passo

```bash
# 1. empacotar o índice (de novo sempre que o índice mudar)
node bench/build.mjs

# 2. baixar os repositórios fixados
node bench/prepare.mjs

# 3. montar o catálogo de cada repositório
node bench/draft-questions.mjs typedoc --per-type 6   # rascunho por um agente SEM o índice (Claude)
node bench/check-drafts.mjs typedoc                   # segunda opinião de outro modelo (Codex), fato a fato
node bench/validate.mjs --drafts --verbose            # arquivo:linha existe? a linha cita o símbolo?
#    leia bench-data/questions/typedoc.review.md (só as perguntas e fatos marcados) e ajuste o .drafts.json se preciso
node bench/promote-drafts.mjs typedoc --approve       # aplica as correções e grava em typedoc.json como "reviewed"
node bench/validate.mjs

# 4. conferir se cada ferramenta e agente sobe
node bench/run.mjs experiments/smoke.json --check

# 5. ver o tamanho e o custo estimado, depois rodar (pode parar e retomar)
node bench/run.mjs experiments/main.json --dry
node bench/run.mjs experiments/main.json --concurrency 4 --max-usd 100

# 6. corrigir, exportar e analisar
node bench/score.mjs experiments/main.json --judge haiku --review 0.1
node bench/export.mjs pilot,main,generalization,ablation,paraphrase,edit
uv run bench/analysis/analyze.py

# sem agentes (grátis)
node bench/oracle/ts-oracle.mjs gearmod
node bench/oracle/ts-oracle.mjs gearmod --ablate types
node bench/perf.mjs --repeat 3 --codegraph
uv run bench/analysis/power.py
```

## Experimentos

| Arquivo | Pergunta que responde | Execuções (aprox.) |
| --- | --- | --- |
| `pilot.json` | O pipeline funciona de ponta a ponta? | 8 |
| `smoke.json` | Cada ferramenta sobe com cada agente? (só `--check`) | — |
| `main.json` | O índice reduz custo sem perder qualidade, comparado a todas as ferramentas? | 3.375 |
| `generalization.json` | O resultado vale para Codex e para um modelo menor? | 1.728 |
| `ablation.json` | Qual parte do índice gera o ganho? | 1.080 |
| `paraphrase.json` | O ganho depende da redação ou do idioma? | 432 |
| `retest.json` | As melhorias de 2026-11-08 no índice ajudam nas perguntas de testes e vagas? (baseline rodado de novo junto) | 304 |
| `retest2.json` | Segunda rodada após as correções na detecção de testes (só GearMod; compara com o baseline do `retest`) | 152 |
| `edit.json` | Em tarefas de edição, com testes como juiz, o ganho se mantém? E o subagente explorador? | ~400 |

## Cuidados de validade (já tratados no código)

- **Mesmo texto para todas as ferramentas.** A dica "há ferramentas de mapa de código" é igual para todas (`config/prompts.json`).
- **Sem instruções de agente nos repositórios.** `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.serena/` e afins são removidos em todas as condições, inclusive nas worktrees de edição.
- **Sem vazamento do gabarito.** O repositório do GearMod é usado sem `bench/`, `spike/` e `docs/`.
- **Ordem aleatória com semente.** Mudanças de horário ou de carga da API não favorecem uma ferramenta.
- **Execuções inválidas ficam registradas.** Se o servidor MCP não conecta, a execução é marcada como falha, não como "sem grafo".
- **Pastas originais nunca são alteradas.** Repositórios locais (como o desrotula e o am-em-chamas) são copiados antes de qualquer limpeza.
- **Ablações isoladas.** `GEARMOD_INDEX_ABLATE` só existe no benchmark; o app nunca a define, e cada ablação usa um banco próprio.

## Formato do catálogo

```json
{ "id": "impact-allowedPath", "type": "impact", "status": "reviewed",
  "variants": [{ "id": "pt", "lang": "pt", "text": "..." }, { "id": "en", "lang": "en", "text": "..." }],
  "facts": [{ "id": "def", "label": "definição em file-viewer.ts:12", "pattern": "file-viewer\\.ts[\\s\\S]{0,150}?\\b12\\b" },
            { "id": "wrong", "label": "afirmação errada conhecida", "pattern": "...", "kind": "bad" }],
  "edit": { "check": ["npm", "test", "--", "x.test.ts"], "allow": ["npm test"] } }
```

Tipos: `locate`, `flow`, `impact`, `tests`, `vague` e `edit`. Um fato `bad` conta como erro quando aparece na resposta.

## Problemas conhecidos

### codebase-memory-mcp não roda nesta máquina (fora do estudo)

Em 2026-11-04, a versão 0.12.1 foi baixada do release oficial e o SHA-256 conferiu com o `checksums.txt`. O executável responde a `--version`, mas recusa instalar e recusa rodar qualquer ferramenta:

```
error: activation could not reserve exclusive access; no activation was committed.
The check that refused was: C:\Users\<usuário>: DACL entry 3 grants mutation rights 0x000d0152
to untrusted identity (other S-1-5-21-…-1004)
codebase-memory-mcp: could not load saved runtime settings
```

- **Causa:** a ferramenta só aceita rodar se nenhuma outra conta puder alterar a pasta de perfil do usuário. Aqui, uma segunda conta local do mesmo dono tem controle total sobre essa pasta. É uma configuração legítima e permanece como está.
- **Tentativas sem sucesso:**
    1. Instalar com `--skip-config`, para não alterar a configuração dos agentes.
    2. Rodar o executável direto, sem instalar.
    3. Redirecionar `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` e `CBM_CACHE_DIR` para outra pasta. Não funciona porque a ferramenta localiza o perfil pela API do Windows, não por essas variáveis.
    4. Criar uma pasta acessível só ao usuário.
- **Consequência para o estudo:** a ferramenta é citada como trabalho relacionado (tem artigo publicado), mas não é medida. A recusa em rodar numa configuração comum do Windows é um custo de adoção e vai registrado nas limitações.
- **Como incluí-la depois:** usar outra máquina ou outro usuário do Windows cujo perfil não dê permissão de escrita a outras contas, ou usar a versão Linux pelo WSL.

### Sandbox do Codex no Windows

O modo `read-only` do Codex bloqueia até a leitura de arquivos nesta máquina, então o agente não consegue ler o código. Por isso, no Windows, o benchmark roda o Codex sem sandbox (`BENCH_CODEX_SANDBOX=none`, o padrão), como no uso normal do dono da máquina. As pastas são cópias descartáveis, e cada execução registra em `modifiedFiles` qualquer arquivo alterado.

### Ferramentas MCP ocultas no Codex

O Codex (CLI 0.163, servidor 0.166) não mostra as ferramentas MCP ao modelo: elas ficam atrás de uma busca de ferramentas. O servidor conecta, mas com a dica comum ("Há ferramentas de mapa de código disponíveis (mcp__graph__*)") o Codex não chamou o grafo nenhuma vez nas primeiras execuções com CodeGraph. Quando a pergunta pede para buscar as ferramentas, ele as encontra e usa.

Por isso o Codex recebe uma frase a mais na dica (`hintCodex` em `config/prompts.json`), igual para todas as ferramentas de grafo. As 5 execuções feitas antes da correção estão em `results/_discarded-generalization-oldhint/` e ficam fora da análise.

## O que ainda depende de você

- **Catálogo:** a revisão das perguntas checadas de cada repositório, lendo os arquivos `questions/<repo>.review.md`.
- **Preços do Codex** em `config/prices.json`, se quiser custo em US$ para ele; os tokens são registrados de qualquer jeito.
- **Tarefas de edição:** cada uma precisa de `edit.check` (o comando de teste) e de o ambiente do repositório estar instalado (Node, Python, Go, .NET, Rust).
