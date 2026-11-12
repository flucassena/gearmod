---
name: gearmod-test
description: Tests an GearMod card by checking the Tasks and acceptance criteria against what was implemented, in the card's worktree. Use when GearMod asks to test the card.
---

# Test card (GearMod)

Write everything you produce for the user — documents, headings, labels, descriptive IDs, questions and chat replies — in the language given in `idioma` (e.g. `pt-BR`, `en`). These instructions are in English; that does not change the output language.

Test this card in the current worktree: check the Tasks and acceptance criteria in the context against what was implemented.

- **Retesting a card that already has a checklist:** read it first (call `gearmod_test_checklist` without `markdown`). Keep the same items and wording, uncheck them all (`- [ ]`, dropping any old "failed" note) and verify each one again, marking as you go. Add items only for what is new in the card and remove only what no longer applies. Never rebuild the checklist from scratch: the user's history of each item depends on it.
- Before starting (no checklist yet), build the checklist of what you will verify and save it with `gearmod_test_checklist` (`- [ ] ...` items, one per verification: tests, lint, typecheck, each acceptance criterion you will check, diff review). As you finish each item, save the checklist again with it marked (`- [x]`); if it failed, leave `- [ ]` and append ` — failed: <reason>` (the word "failed" in the language of `idioma`; pt-BR: ` — falhou: <motivo>`). The user follows this checklist next to the chat. **"failed" only when you ran the check and it did not pass.** If you could not verify an item (no browser/Playwright, needs a manual check, missing tool or data), leave `- [ ]` and append ` — pending: <what is missing>` (pt-BR: ` — pendente: <o que falta>`); never write "failed" for it: a failure makes the app offer to send it to the developer, while pending tells the user what they must check.
- **Look at the code with the index, not by reading whole files** (also when the user asks something about the code in this chat, even outside the checklist): `gearmod_code_explore` for an area or flow, `gearmod_code_node` for one symbol, `gearmod_code_callers` to see who reaches it (how a screen or function is reached), `gearmod_code_map` to get oriented in an unfamiliar area. Grep stays for plain text.
- Run the project's tests, lint and typecheck, review the diff and point out whatever fails, with the reason and where. `gearmod_code_affected_tests` lists the tests that depend on the changed files, and `gearmod_code_impact` shows what else a changed symbol reaches (regressions to check).
- Use the Plan's test plan and the Tasks' criteria as your script: run the whole suite, check each listed regression and validate each criterion.
- Judge the automated tests the developer wrote: do the ones the test plan asks for exist? Do they really cover the criterion (not empty, not just "doesn't break")? A missing or weak test becomes a failed item in the checklist with the reason; you do not write their code. Anything not in the documents that needs testing becomes a proposal with `gearmod_propose_change`.
- Mark with `gearmod_mark_task` only what you actually verified. When finished, update the Summary with `gearmod_write_document` saying whether it is ready or what is missing.
- If you have a question the documents do not answer, use `gearmod_ask_planner`, continue only with what does not depend on it and end the execution: the app resumes you with the answer.
- Do not change the code unless the user asks, and do not move the card to another column.

## On-screen tests with Playwright

Two tools, for different things (they can be combined):

- **Playwright CLI (`playwright-cli`)**: to explore and check the screen while spending little context. When the context carries `playwrightCli` (the user turned it on and installed it in the project), use it by default for every acceptance criterion that can only be verified on screen, without waiting to be asked (it spends far fewer tokens than reading the page any other way), and run the project's automated tests in the same pass. Without `playwrightCli`, do not try to drive a browser. Use the path in `comando`.
  - Always in the card's session: `<comando> -s=<sessao> open <url>`, then `snapshot`, `click <ref>`, `fill <ref> <text>`. Headless is the default; `--headed` only if the user asks to watch.
  - Prefer `snapshot` and refs over screenshots. Take a screenshot only to prove a criterion or a failure: `<comando> -s=<sessao> screenshot --filename=<evidencias>/<criterion>.png`, and cite the path in the checklist.
  - Do not paste repeated full snapshots or huge logs in the reply: summarize what you saw and point to the file.
  - When finished: `<comando> -s=<sessao> close`.
  - The CLI does not replace a versioned suite: if the criterion must stay covered, say that a Playwright Test is worthwhile.
- **Playwright Test**: automated, reproducible tests, as below.

Use Playwright to check the acceptance criteria that can only be verified on screen (appears only for a certain profile, dialog closes on cancel, full flow). Unit tests, lint and typecheck are still run as usual.

- **Project already has Playwright** (`playwright.config.*` or `@playwright/test` in `package.json`): run `npx playwright test --reporter=line` in the worktree and put the result as a checklist item. For a specific criterion, run only the file or the title with `-g`.
- **No window by default (headless).** Keep `video`/`trace`/`screenshot` on only for failures (`--trace=retain-on-failure`) and record in the checklist the path of the trace or screenshot of each failure (`npx playwright show-trace <file>` opens the trace).
- **If the user asks to watch** ("see the browser", "show it on screen"): run with `--headed` and, if possible, `slowMo: 400` in `launchOptions`, to give time to follow. `--ui` mode only if the user asks, because it opens an interactive window that waits for them.
- **Need the application server running?** Start the project's development command in the background, wait for the port to respond and stop the process when finished. Do not leave a server running.
- **Browsers missing, or Playwright not in the project at all?** Do not install anything on your own: downloading browsers is ~150 MB. Tell the user (or open a proposal with `gearmod_propose_change`) and continue with what can be tested without it.
- Test the screen the way the user uses it (click, type, wait for the visible result), not the implementation internals. Mark the task only when the criterion was actually observed.

- **Reassessment:** if validation turns out much harder than the card's assessment predicted, or the same tests fail again after a fix, reassess with `gearmod_assess_complexity` (trigger `failures` or `risk`).
