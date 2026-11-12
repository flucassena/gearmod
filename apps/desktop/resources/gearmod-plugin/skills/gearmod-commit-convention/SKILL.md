---
name: gearmod-commit-convention
description: Writes commit messages in the convention of each repository (e.g. `feat(#ASF-9503): Nova análise...`), read from GearMod with gearmod_commit_convention, and reviews that convention when it was deduced automatically. Use before any commit in a card, by an agent or by another skill.
---

# Commit messages in the repository's convention (GearMod)

Each repository has its own way of writing commit messages: `feat(#ASF-9503): Nova análise de crédito`, `fix: corrige timeout`, `Add retry to the importer (ABC-12)`. GearMod keeps that convention for every repository in its own data (one entry per repository, with the date of the last analysis). Nobody sets it up by hand: it is found from the history and analyzed again on its own after about a month.

## Before every commit

1. **Read the convention.** Call `gearmod_commit_convention` with `repositorio` (the repository of the commit; optional when the project has only one). If there is no convention yet, or it is about a month old, GearMod analyzes the recent history first and saves it, so what you get is always current. The answer has the description, examples and the latest commits.
2. **Write the message in that convention:**
   - The form of the first line (e.g. `type(scope): text`) and the types the repository uses (`feat`, `fix`, `chore`, `refactor`...).
   - The ticket: where it goes and how it is written (`#ASF-9503` in the scope, `[ABC-12]` at the start...). Take it from the card branch name, the card title or the card description. If the card has no ticket, leave it out; never invent one.
   - The language and the case of the repository's commits, even when it differs from `idioma`.
   - One summary line; extra detail goes in the body after a blank line, only if the repository's commits have bodies.
3. **Commit through GearMod:** `gearmod_request_commit` with `mensagem`. Never run `git commit` yourself. If the message clearly breaks the convention (e.g. no `type(scope):` prefix where every commit has one), the tool returns it with the convention: rewrite and request again. Use `ignorar_padrao: true` only when the user asked for that exact message.

## Review an automatic description

When the answer says the description was deduced automatically, compare it with the recent commits it lists. If it misses something you can see there, save a better one with `gearmod_commit_convention`, passing `descricao` and `exemplos`:

- `descricao`: a few short lines on how messages are written: the form of the first line, the types, where the ticket goes and its format, language, case, length, whether there is a body. Write rules, not a single message.
- `exemplos`: 3 to 8 real messages from the history that show the convention well (most recent first).

Save only what the history shows. Do not save a convention from one or two commits, and do not change it because of a single odd commit. A saved description is used by every later commit of that repository and by the "suggest message" button of the Git page, until it is analyzed again.
