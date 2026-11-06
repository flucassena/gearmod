---
name: gearmod-tasks
description: Writes and updates the Tasks document of an GearMod card in SDD style (T001 tasks in phases, [P] parallelism marker, traceability to the story, file paths) with acceptance criteria inside each task. Use during planning to break down the Plan and during execution to mark what was completed.
---

# Document: Tasks

The Tasks are the checklist that execution follows. The structure follows the GitHub Spec Kit tasks template, trimmed down for a card, with one GearMod difference: **each task carries its own acceptance criteria** (there is no separate criteria document). The number on the board card (e.g. 2/5) counts the tasks.

## Language

Write everything you produce for the user — documents, headings, labels, descriptive IDs, questions and chat replies — in the language given in `idioma` (e.g. `pt-BR`, `en`). These instructions are in English; that does not change the output language. Use `templates/<idioma>.md`; if there is none, translate `templates/pt-BR.md`. The IDs and markers (`T001`, `[P]`, the story tag such as `[H1]`) follow the template of that language.

## Format (mandatory: GearMod reads this format)

- A `## Tasks` heading at the top and one `### Phase ...` section per phase (phase heading in the language of `idioma`).
- Each task is a **top-level** list item:
  `- [ ] T001 [P] [H1] <imperative verb> <what> in \`<real/path>\``
  - `<real/path>`: confirm it exists (or mark it "(new)") with `gearmod_code_search` or `gearmod_code_node`; never invent a path.
  - `T001`: sequential number, in execution order, with no gaps.
  - `[P]`: optional; only when the task touches different files from the other tasks in the phase and does not depend on them.
  - `[H1]`: the Specification story that the task delivers (H1 = Story 1; the story tag follows the template of `idioma`). Setup, foundation and polish tasks carry no story.
- The task's **acceptance criteria** go right below it, indented by 2 spaces:
  `  - [ ] <observable or testable criterion>`
- Each phase ends with a line `**Checkpoint:** <what must work here>` (label in the language of `idioma`; pt-BR: `**Ponto de verificação:**`).

## Phases

1. **Setup:** only if the card needs it (dependency, configuration).
2. **Foundation:** whatever blocks the stories (migration, IPC contract, shared type).
3. **One phase per story**, in priority order (P1 first; the P1 phase is the MVP). Writing automated tests is development work: it goes inside the task itself (criterion "test X written in `<path>` and passing") or in a dedicated test-writing task, placed before the implementation when the Specification asks for that.
4. **Polish:** only if there is real work (cleanup, documentation). Never a "run the validation" task.

For a small card, use only the phases needed (sometimes just one).

## What is not a task

A task is development work that the developer does and delivers. **Do not create verification-only tasks**, such as "run lint, type-check and the suite", "confirm that button X still works" or "manually test the flow":

- checking regressions, running the whole suite and validating criteria on screen belong to the **test stage**: write that in the Plan's test plan section, and the tester runs it;
- running lint, type-check and the tests of the changed area is the **developer's definition of done**; it already applies to every task and does not become an item.

**Also do not create tasks or criteria that the developer cannot do or observe.** The developer works in code and in a terminal; it does not open the app, click through screens, use a browser, a real device or production, nor does it have credentials or access to external services. So never write a task or a criterion that depends on any of these:

- manual testing, "see it on screen", "open the app and check", visual checks;
- browser or end-to-end (E2E/Playwright) runs, smoke tests of the running app;
- real external services, real accounts/keys, deployed environments, data the developer does not have.

Cover that behavior in two ways: (1) a criterion the developer can meet in code, such as a unit/component/integration test written in `<path>` and passing (with mocks or fixtures for what is external); (2) the manual, on-screen or E2E check goes to the Plan's **Test plan**, where the tester runs it. Writing an E2E test file is fine when the project has that setup; *running* it against the live app is the tester's job.

GearMod rejects a Tasks document with such a task and returns the error for you to fix. This also applies when the project's method (Spec Kit, OpenSpec or another) has validation tasks in its own template.

## Rules during planning

- Coverage: every `RF-xxx` and every acceptance scenario of the Specification appears in at least one criterion of some task.
- Each task fits in one work session, cites the real file path and can be verified on its own. No "improve the code" or "tweak things".
- Each task has 1 to 3 criteria. A criterion is something the developer can verify in code or with an automated test ("the dialog component renders two options: test written in `<path>` and passing"), never "works well", "the whole suite passes" or something that needs the running app on screen.
- Avoid two [P] tasks on the same file and dependencies between stories that break their independence.

## Rules during execution

- Follow the order. Make one commit per task or per logical group, if the project uses commits.
- Mark a criterion `[x]` only after verifying it. Mark the task `[x]` only when all its criteria are marked.
- Stop at each **Checkpoint** and confirm it holds before moving on.
- Never delete tasks or criteria. New work becomes a task at the end of the phase with the suffix "(added during execution)" (in the language of `idioma`; pt-BR: "(adicionada na execução)"); tell the user in the chat.
- If a criterion cannot be met, leave it unchecked and explain in the chat.

## Delivery

Send it with `tipo` = `tasks` (tool `gearmod_write_document` or markers, as described in `gearmod-planning`). During execution, if the `gearmod_mark_task` tool exists, use it to mark items instead of resending the document.
