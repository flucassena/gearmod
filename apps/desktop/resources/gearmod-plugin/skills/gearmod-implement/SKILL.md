---
name: gearmod-implement
description: Implements an GearMod card following the Plan and Tasks in the context, in the card's worktree. Use when GearMod asks to implement the card.
---

# Implement card (GearMod)

Write everything you produce for the user — documents, headings, labels, descriptive IDs, questions and chat replies — in the language given in `idioma` (e.g. `pt-BR`, `en`). These instructions are in English; that does not change the output language.

Implement this card following the Plan and Tasks in the context, in the current worktree.

- Preserve existing changes. Write the automated tests that each task asks for together with the code.
- **Find the code with the index**, not by reading whole files: `gearmod_code_explore` for an area or flow, `gearmod_code_node` for one symbol, and `gearmod_code_impact` before changing or renaming anything (it lists every call with its line, mentions in strings/mocks and the tests to run). Grep stays for plain text. To pick the tests of the area you changed, use `gearmod_code_affected_tests`.
- **Definition of done** (applies to every task, it is not a task): before delivering, run lint, type-check and the tests of the area you changed, and fix whatever fails. The whole suite, regressions and on-screen validation belong to the tester, via the test plan.
- Mark each acceptance criterion with `gearmod_mark_task` as soon as you meet it, and each task as soon as you finish it, right then (do not leave it for the end): the user follows the Tasks next to the chat. When finished, update the Summary with `gearmod_write_document` (status, progress and next step).
- Commit: never run `git commit` directly. First read the repository's commit convention with `gearmod_commit_convention` and write the message in it (form, ticket, language and case of that repository; see the gearmod-commit-convention skill). Then request it with `gearmod_request_commit` (`arquivos` only if the commit is not for everything). The project's rule is in the `commit` field of the context: if it says to ask permission, the user authorizes it on the card and you continue with whatever does not depend on the commit; if it says not to commit, leave the changes in the worktree.
- The card's documents are the contract between stages: implement what is in them and nothing else.
- **Test failures:** when the context carries `falhasDoTeste`, those are the items the tester marked as failed in the last test pass. Fix them when you are asked to (the user sends them from the card), following the documents; a failure that needs something outside the documents becomes a proposal, as below. Do not mark the test checklist: the tester verifies again.
- If something outside the documents is needed (new scope, requirement, extra refactoring), do NOT do it: record it with `gearmod_propose_change` and continue only with what is in the documents. The user authorizes before any change.
- If you have a question the documents do not answer, record it with `gearmod_ask_planner`, continue only with what does not depend on it and end the execution: the app takes the question to the planner and resumes you with the answer.
- Do not move the card to another column: that is up to the user.

- **Reassessment:** if the implementation requires an architectural change, reveals a new dependency or fails repeatedly for the same reason, reassess with `gearmod_assess_complexity` (trigger `architecture`, `new-dependency` or `failures`) before going on. Relevant technical decisions you made: `gearmod_record_decision` with origin agent.
