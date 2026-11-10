---
name: gearmod-discovery
description: Discovery of a request in GearMod (discovery-intake). Use at the start of the free chat or of a card's planning to understand the request, explore the code read-only, record the understanding, assess complexity on six dimensions and recommend the flow (short, light spec or SDD).
---

# Request discovery (GearMod)

Write everything you produce for the user (documents, headings, labels, descriptive IDs, questions and chat replies) in the language given in `idioma` (e.g. `pt-BR`, `en`). These instructions are in English; that does not change the output language. Any example phrasing below must be said in `idioma`.

Goal: turn an informal conversation into requirements clear enough to plan or implement, without losing decisions and without generating documentation too early. It is not a form: have a conversation.

## 1. Understand

- Identify the goal, the problem/motivation, what is in and what is out, constraints and implicit requirements (security, performance, compatibility, existing data).
- Ask only what changes the outcome: up to 3 questions per message, using the `gearmod-perguntas` block when there are options.
- Do not assume technical details the code can answer: explore before asking.

## 2. Explore the code (cheap and read-only)

- If the context already carries a "Exploração do código" (code exploration) section that is valid for the current version, reuse it. Explore again only when it is marked DESATUALIZADA (outdated) or the request changed.
- Start with the code index: `gearmod_code_explore` with the request in your own words plus any symbol or file names you already know. In one call it returns the relevant code, the call path, what depends on it and the tests; treat that code as already read and do not open those files again.
- Use `gearmod_code_impact` to see everything a change touches (callers with the line of each call, mentions in strings/mocks, tests to run) and `gearmod_code_node` for one symbol or file. Use Grep/Glob only for plain text (messages, config keys) or when the index has no answer. Read only the relevant parts; never the whole workspace.
- For a truly broad exploration, delegate it to the `gearmod-explorer` subagent when it is available (it uses the same index and returns a short report); the extra cost has to pay off.
- Look for: affected modules and repositories, similar implementations, contracts/APIs, dependencies and existing tests.
- Record the result with `gearmod_record_exploration` (compact summary + evidence with path and line). The app stores the code version alongside it.

## 3. Record the understanding

Call `gearmod_record_understanding` with goal, motivation, scope, exclusions, acceptance criteria, open items, technical context (real paths) and `prontidao` (`pronto` or `precisa_esclarecer`; "ready" or "needs clarification"). Call it again only when something relevant changes.

Decisions the user makes in the chat: `gearmod_record_decision` with `origem: "usuario"`. Your own recommendations: `origem: "agente"` (the user approves them on the card). To replace a decision, use `substitui`.

## 4. Assess complexity

Call `gearmod_assess_complexity` with a score from 0 to 3 per dimension and an objective justification (a verifiable fact, not internal reasoning). The dimension names are the keys the app expects; keep them as written (the English gloss is in parentheses):

| Dimension | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| escopo (scope) | 1 file | a few files of one module | several modules | several repositories or the whole system |
| acoplamento (coupling) | isolated | 1 dependency | shared contracts | changes public contracts/data |
| incerteza (uncertainty) | everything clear | 1 open detail | partial requirements | goal still vague |
| risco (risk) | none | local regression | data, security or money touched | loss of data, security or production |
| novidade (novelty) | project standard | known variation | technology new to the project | no precedent |
| validacao (validation) | obvious test | unit test | integration/E2E | hard to reproduce |

- With no evidence yet (before exploring), set `preliminar: true` and `confianca: "baixa"` (low).
- List `riscos_criticos` separately from the score; risk 3 never goes to the short flow.
- Provide evidence (`file`, `commit`, `message`, `test`, `api`...) with path/line.
- Reassess only with a real `gatilho` (`requirements-changed`, `new-dependency`, `risk`, `architecture`, `scope`, `failures`). The app rejects assessments identical to the current one.

## 5. Recommend the flow

The app returns the score and the recommended flow. Right after it, call `gearmod_choose_workflow` with the flow you recommend (`confirmado_pelo_usuario: false`). The app shows the user, in the chat, the score table, the points bar and the flow options with yours marked; the user picks there. Do not ask which flow in the chat (no `gearmod_ask_user` for this): at most one or two sentences with the points, the level and the main reason. The options the user sees:

- `light` (simple): short workflow; a single agent implements and validates, with no Specification/Plan/Tasks. It is a workflow, not a card type.
- `spec` (medium): concise Specification, Plan and Tasks from GearMod.
- `sdd` (complex): for this card, recommend either GearMod's SDD or GitHub Spec Kit, explaining the reason in the context of the task. Consider GearMod for evolving existing features and Spec Kit for new work, as suggestions, not fixed rules. The final choice is the user's.

For SDD provide `metodo` and `motivo` in `gearmod_choose_workflow`; `motivo` appears in the card, so make it one short sentence about this card. Then stop and wait: the app resumes you when the user chooses (the chosen flow may differ from yours). If they correct a premise, record the decision and reassess with the right trigger; the previous assessment stays in the history.
