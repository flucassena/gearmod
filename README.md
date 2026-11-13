<div align="center">

# GearMod

**Multi-Agent Development Workspace**

*Shift gears. Build faster.*

[![Download for Windows](https://img.shields.io/badge/Download-Windows%20x64-2563eb?style=for-the-badge&logo=windows)](https://github.com/flucassena/gearmod/releases/latest)

[![CI](https://github.com/flucassena/gearmod/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/flucassena/gearmod/actions/workflows/ci.yml)
[![License: PolyForm Shield 1.0.0](https://img.shields.io/badge/license-PolyForm%20Shield%201.0.0-555)](LICENSE.md)
![Platform: Windows 10/11, Linux x64 and macOS (preview)](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011%20%7C%20Linux%20x64%20%7C%20macOS%20(preview)-555)

**English** · [Português](README.pt-BR.md)

</div>

GearMod is a desktop app that turns your work into cards on a kanban board and hands each card to a coding agent, such as **Claude Code** or **Codex**. Every card runs in its own Git worktree, so agents work in parallel without touching your main checkout, and you review, commit and merge from the same window.

Everything runs on your machine. GearMod drives the agent CLIs you already use and has no server or account of its own.

![The GearMod board with cards in Backlog, To do, Doing, Test and Done](.github/assets/board.png)

## Features

**Plan before the agent writes code**
- Each card has a summary, a specification, a plan and a task list, written with the agent in a planning chat.
- Planning, implementation and testing are separate steps, each with its own chat, agent, model and permission mode.
- Spec-driven workflows, including [Spec Kit](https://github.com/github/spec-kit) projects, and a project Constitution that every agent follows.

**Run agents safely, side by side**
- One Git worktree and branch per card, named after the card type (`feature/…`, `fix/…`, `improvement/…`).
- Agents get a minimal environment instead of your full one, and risky actions ask first.
- Several agents can work at the same time; GearMod shows what each one is doing and how many tokens it used.

**Review and ship from one place**
- A built-in Git page with the commit graph, diffs, conflicts resolved block by block, rebase, stash and pull requests for GitHub and GitLab.
- An editor, a terminal and a file explorer next to the board, with the card's worktree as the working folder.
- A secret scan that blocks agent commits containing unmistakable keys or passwords.

**Tools for the agents**
- A local MCP server lets agents read and update their card, ask you questions and request commits.
- A local code index gives agents symbol search and "which tests does this change affect" (see [Code index](#code-index)).
- Skills, global or per project, picked with `/` in any chat.

**Optional extras**
- Voice dictation (local whisper.cpp or Groq), a PostgreSQL manager (experimental) and Playwright CLI for the tester agent.

![A card with its specification, plan and tasks](.github/assets/card.png)

## Install

**Requirements**
- Windows 10 or 11, 64-bit, or Linux x64 with a desktop (tested on Ubuntu 22.04 and newer). macOS 12 or later is in preview: packages are built, but not tested by users yet.
- [Git](https://git-scm.com/downloads).
- At least one agent CLI, installed and signed in: [Claude Code](https://docs.claude.com/en/docs/claude-code) or [Codex](https://github.com/openai/codex).

**Steps on Windows**
1. Open the [latest release](https://github.com/flucassena/gearmod/releases/latest) and download `GearMod-Setup-<version>-x64.exe`.
2. Run the installer. It installs for your user only and does not need administrator rights.
3. The installer is not code-signed yet, so Windows SmartScreen may show **"Windows protected your PC"**. Click **More info** and then **Run anyway**.
4. Open GearMod from the Start menu.

To check the download, compare its hash with `SHA256SUMS.txt` from the same release:

```powershell
Get-FileHash .\GearMod-Setup-<version>-x64.exe -Algorithm SHA256
```

To update, install the new version over the old one; your data is kept. To uninstall, use **Settings › Apps** in Windows. Uninstalling does not delete your data.

**Steps on Linux (x64)**

The [latest release](https://github.com/flucassena/gearmod/releases/latest) has two Linux packages; pick one.

- **`.deb` (Debian, Ubuntu and derivatives):** download `GearMod-<version>-amd64.deb` and install it with:

  ```sh
  sudo apt install ./GearMod-<version>-amd64.deb
  ```

  GearMod shows up in the applications menu. To update, install the new `.deb` the same way; to uninstall, run `sudo apt remove gearmod`.
- **AppImage (any distribution):** download `GearMod-<version>-x86_64.AppImage` and run:

  ```sh
  chmod +x GearMod-<version>-x86_64.AppImage
  ./GearMod-<version>-x86_64.AppImage
  ```

  If it fails with an error about FUSE (`libfuse.so.2`), install `libfuse2` (`sudo apt install libfuse2t64` on Ubuntu 24.04, `sudo apt install libfuse2` on 22.04) or start it with `./GearMod-<version>-x86_64.AppImage --appimage-extract-and-run`.

To check the download, put it in the same folder as `SHA256SUMS.txt` from the same release and run:

```sh
sha256sum -c SHA256SUMS.txt --ignore-missing
```

GearMod stores secrets (API keys, tokens) in the system keyring, so Linux needs **gnome-keyring** or **KWallet** running. Without one, GearMod still opens, but it refuses to save secrets and says why. Signing in, installing or updating an agent CLI opens a terminal window (your `$TERMINAL`, or the first of `x-terminal-emulator`, GNOME Terminal, Konsole, Xfce Terminal, kitty, Alacritty and xterm found).

**Steps on macOS (preview)**

1. Open the [latest release](https://github.com/flucassena/gearmod/releases/latest) and download `GearMod-<version>-arm64.dmg` (Apple Silicon: M1 and later) or `GearMod-<version>-x64.dmg` (Intel).
2. Open the `.dmg` and drag GearMod to **Applications**.
3. The app is not notarized by Apple yet, so macOS blocks the first launch (it says GearMod "is damaged" or "cannot be opened"). Run this once in Terminal, then open GearMod normally:

   ```sh
   xattr -dr com.apple.quarantine /Applications/GearMod.app
   ```

To check the download, run `shasum -a 256 -c SHA256SUMS.txt --ignore-missing` in the folder with the `.dmg` and `SHA256SUMS.txt`. To update, download the new `.dmg` and replace the app in Applications; your data is kept. Signing in, installing or updating an agent CLI opens a Terminal window. GearMod reads your shell's PATH (zsh by default), so CLIs installed with Homebrew, npm or nvm are found.

## Quick start

1. **Add a project.** Click **New project** and pick one or more Git repositories.
2. **Add an agent.** In **Settings › Agents**, register the Claude Code or Codex CLI you already use. GearMod detects installed CLIs and the account each one is signed in to.
3. **Create a card.** Describe what you want. The planning chat helps you write the specification, the plan and the tasks.
4. **Start the card.** GearMod creates the worktree and branch, and the agent implements the tasks. Answer its questions and approve risky actions as they come.
5. **Test and review.** Run the test step, read the diff on the Git page, then commit and open a pull request.

## A card from start to finish

The screenshots in this section come from a real run: three cards on a sample personal-finance app ("Ledgerly", Angular + Supabase), planned, implemented and tested by Codex inside GearMod.

| Card | Score | Workflow |
| --- | --- | --- |
| Show negative balances in red on the dashboard | 3, simple | Short flow |
| Export purchases to CSV | 15, medium | Light spec |
| Monthly budgets per category (new table, row-level security, new page) | 24, complex | Full SDD |

**1. Plan.** Open the card's planning chat and ask the agent to plan it. In this step the agent can only read code, never change it. It explores the code first, scores the card's complexity and proposes a workflow. Its questions show up as choices in the chat, and switching the workflow waits for your approval. For the SDD card, the agent then asked three product questions (what counts as spending, what happens to existing limits when copying, which categories can have budgets) before writing the plan.

![The planning chat recommends the full SDD and asks which workflow to use](.github/assets/flow-choice.png)

**2. Read the documents.** The plan is saved on the card as Markdown documents, with version history: summary, specification, plan (with a test plan) and tasks. The short flow keeps only a short "what to do" note. You can edit any document before starting.

![The SDD card's plan, with technical context, principles check and decisions](.github/assets/card-plan.png)

**3. Implement.** Starting the card creates its worktree and branch (`feature/monthly-budgets-per-category-…`). The implementation agent works through the tasks and ticks them off in the side panel as it goes; the changed files show below the tasks. When it is done, the agent asks to commit, and you authorize, edit the message or deny.

![The implementation chat with all six tasks done and the agent asking to commit](.github/assets/card-execution.png)

**4. Test.** The test step runs a separate agent with its own checklist. It records what passed and what it could not check. Here it ran 5 tests covering 90 filter combinations and a production build. It also reported that real-browser downloads were left unchecked because Playwright was not set up.

![The test chat with its checklist](.github/assets/card-test.png)

**5. Review and merge.** Every card's commits show up on the Git page, tagged with the card. From there you can read the diffs, merge, or open a pull request.

## How GearMod picks the workflow

Not every card needs a full spec. GearMod scores each card and recommends a workflow, and you make the final choice.

**The score.** The planning agent rates the card from 0 to 3 on six dimensions:

| Dimension | Default weight |
| --- | --- |
| Scope | 2 |
| Coupling | 2 |
| Uncertainty | 2 |
| Risk | 3 |
| Technical novelty | 1 |
| Validation difficulty | 1 |

The total is the sum of score × weight; with the default weights the maximum is 33. Each score comes with a justification and evidence: files with line numbers, the commit that was analyzed, or your own message.

![The assessment dialog: 24 points, complex, with a justification for each dimension](.github/assets/flow-assessment.png)

**The recommendation.**

| Total (default limits) | Level | Recommended workflow |
| --- | --- | --- |
| 0–7 | Simple | **Short flow**: one agent implements and validates from a short description. There is no specification, plan or task document, and no separate test step. |
| 8–16 | Medium | **Light spec**: a short specification with acceptance criteria, a plan and tasks. |
| 17 and up | Complex | **Full SDD**: specify, clarify, plan (with a test plan), tasks, verify, summary. |

A card with risk 3 is never recommended the short flow; it goes up to light spec at least. Weights (0–5) and limits can be changed per project under **Project settings › Workflow**.

![Dimension weights and level limits in the project settings](.github/assets/flow-weights.png)

**Your decision.**
- The agent records the score with `gearmod_assess_complexity` and proposes the workflow with `gearmod_choose_workflow`. The proposal is an approval request. Nothing changes until you answer.
- You can pick a different workflow; the card shows when your choice differs from the recommendation.
- You can dispute the scores. That creates a new assessment version marked as your correction.
- Assessments are versioned, never overwritten. A *preliminary* assessment is one made before the agent explored the code. Each new version shows the *delta* from the previous one.
- The full SDD runs either GearMod's own method or [Spec Kit](https://github.com/github/spec-kit). Spec Kit requires the project to be set up for it, and then uses Spec Kit's own skills.
- Every agent follows the project Constitution (`.gearmod/constitution.md`, or `.specify/memory/constitution.md` for Spec Kit).
- Each card keeps a log of decisions and evidence (`history.jsonl`) and a `discovery.md` with the score table.

## Git manager

The **Git** view is a full Git client built around cards.

![The Git page: commit graph with branches and worktrees per card](.github/assets/git-graph.png)

- **Graph:** a commit graph with local, remote, tag and worktree labels. Commits made by agents carry the agent's icon and the card they belong to.
- **One branch and worktree per card:** each card works in its own folder and branch. Your main checkout is never touched. The sidebar lists branches (grouped by prefix), worktrees, pull requests and stashes.
- **Per-card panel:** shows the base branch and the card branch for each repository, commits ahead and behind, and uncommitted files. From there you can commit (with a suggested message), push, open a draft PR, or delete the worktree.
- **Changes and diffs:** stage and unstage per file, discard, stash a single file, add to `.gitignore`, and amend. Diffs open for working files and for any commit, and you can edit a file right in the diff.
- **Branches and commits:** checkout, merge, rebase, cherry-pick, revert, reset, reword, and create branches or tags. Pull and push support fetch, fast-forward and rebase. A rejected push offers pull, pull with rebase, or force push. Most operations can be undone and redone.
- **Conflicts:** resolve merge, rebase, cherry-pick, revert and stash conflicts block by block. For each block, accept current, incoming or both; or take a whole file from one side. Then continue or abort.
- **Agent commits need permission:** the project's commit rule decides whether agents commit freely, ask first, or never commit. Rules can be set per branch. By default agents ask, and never commit to `main`, `develop` or `release/*`. A secret scan blocks agent commits that contain unmistakable keys or passwords.
- **Pull requests:** for GitHub and GitLab you can list, read (description, reviews, comments, diff), comment, approve or request changes (GitHub), and create PRs.
- **Accounts and tokens:** under **Project settings › Git**, set one token per host for the project, optionally overridden per repository. Tokens are never shown again after you save them.

## Database manager (experimental)

A PostgreSQL client inside the project, for checking the data your cards change. It is on by default; set `GEARMOD_DATABASE_EXPERIMENTAL=0` to hide it.

![The database view: connection tree, a SQL tab and a table with paging](.github/assets/database.png)

- **Connections:** a server can hold several databases. Each connection has a class (`dev`, `test`, `prod`, `external`). Any non-local host counts as `external`.
- **Writes are a per-connection switch:** `dev` and `test` start writable, `prod` and `external` start read-only. Turning writes on for `prod` or `external` asks you to type the database name. In the SQL editor, `DROP`, `TRUNCATE`, and `DELETE`/`UPDATE` without `WHERE` ask for confirmation.
- **Passwords:** stored encrypted, or kept only for the session.
- **Tree and tabs:** server › database › schema › tables, views and sequences, with search. SQL and table tabs can be split and rearranged.
- **SQL:** run with Ctrl+Enter and cancel with Esc. Results show up to 1,000 rows with timing and row counts. Every query is saved in a history.
- **Tables:** filter with `WHERE` and `ORDER BY` (with autocomplete), sort by column, page through 10–1,000 rows at a time, and get an exact count on demand. On writable connections you can edit cells and add or delete rows, preview the generated SQL, and then apply it.
- Agents cannot use these connections yet.

## Code index

GearMod keeps a local map of the project's code: functions, classes, calls, imports and tests. Agents query the map before opening files, so they read less to find the right code. The editor uses it too.

![The code index section in the project settings](.github/assets/code-index.png)

- **On by default, per project:** turn it off under **Project settings › General**, and agents fall back to plain search and file reads.
- **Local:** stored in `code-index/index.sqlite` inside the GearMod data folder. It indexes each project folder and each card's worktree.
- **How it's built:** parsed with tree-sitter in a background process. Unchanged files are reused, and changed files are re-indexed as you save. Folders such as `node_modules`, `dist`, `build` and `.venv`, and files over 1 MB, are skipped.
- **Languages:** TypeScript, JavaScript, Python, Go, Java, C#, Rust, PHP, Ruby and C/C++.
- **Agent tools:**
  - `gearmod_code_explore` answers a question or a list of names with the relevant code, call paths, dependents and tests.
  - `gearmod_code_node` shows one symbol with its callers and what it uses.
  - `gearmod_code_search` finds symbols by name.
  - `gearmod_code_impact` lists everything that uses a symbol and the tests to run.
  - `gearmod_code_affected_tests` lists the tests that depend on the files you changed.
- **Editor shortcuts:** Ctrl+T (go to symbol), Ctrl+Shift+O (outline), F12 (definition) and Shift+F12 (references).

## How it works

```
Card ──► Git worktree + branch ──► Agent CLI (Claude Code / Codex)
  ▲                                            │
  └──────── MCP server (card, questions, commits) ◄┘
```

- **Worktrees:** each card gets its own folder and branch, so several agents can work at once without stepping on each other or on your main checkout.
- **Your agents, your accounts:** GearMod starts the CLIs you have installed, with your sign-in and your plan. It does not proxy or resell model access.
- **MCP bridge:** agents talk back to GearMod through a local MCP server to update the card, ask you questions and request commits.

## Your data

Everything lives on your machine, under `%APPDATA%\GearMod` on Windows, `~/.config/GearMod` on Linux or `~/Library/Application Support/GearMod` on macOS: the SQLite database, attachments, backups and card worktrees. GearMod itself sends nothing anywhere. Optional features reach the network only when you turn them on; [SECURITY.md](SECURITY.md) lists them.

GearMod is **not a sandbox**: agents run with your user's permissions, within the permission mode you choose. Read [SECURITY.md](SECURITY.md) for what is and isn't promised.

## FAQ

**Is GearMod open source?**
GearMod is **source-available** under the [PolyForm Shield License 1.0.0](LICENSE.md). You can read, use, modify and redistribute the code, including inside a company, but you cannot use it to offer a product that competes with GearMod. It is not an OSI-approved open source license.

**Does it cost anything?**
GearMod is free to use. The agents use your own Claude or OpenAI plan.

**Does it work on macOS or Linux?**
Linux x64 is supported (see the install steps above). macOS packages are in preview: they are built for every release, but have not been tested by users yet.

**Which agents are supported?**
Claude Code and Codex. Gemini CLI support exists but is disabled for now.

**Can I contribute?**
Outside pull requests are not accepted yet; bug reports and suggestions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Build from source

You need Node.js 22+, pnpm 11+ and Git on Windows.

```powershell
pnpm install      # also rebuilds better-sqlite3 for Electron
pnpm dev          # run the app in development mode
pnpm typecheck
pnpm lint
pnpm test
```

Build a runnable executable or the installer:

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1       # apps/desktop/dist/win-unpacked/GearMod.exe
powershell -ExecutionPolicy Bypass -File .\installer.ps1   # apps/desktop/dist/GearMod-Setup-<version>-x64.exe
```

Both scripts close a running `GearMod.exe` from `win-unpacked`, because it locks the folder. The tests swap the native `better-sqlite3` binary between Node and Electron, so don't run them while the app is open from the same folder. Set `GEARMOD_DATA_DIR` to run against a throwaway data folder.

Releases are built by GitHub Actions: pushing a tag such as `v0.4.0` (matching the version in `apps/desktop/package.json`) builds the Windows installer, the Linux packages and the Mac disk images and publishes them with their checksums. What a version brings goes in `release-notes/<version>.md`, which opens the Release notes, with the Portuguese text in `release-notes/<version>.pt-BR.md`. The download page shows both.

```
apps/desktop        Electron app (main process, preload, React renderer)
packages/contracts  Shared types and IPC contracts (Zod)
scripts             Maintenance scripts (third-party notices, Codex protocol types)
spike               Code index experiments (generates the tree-sitter queries)
```

## Contributing

GearMod does not accept outside pull requests yet: all changes are made by the maintainer. Bug reports and suggestions are welcome as [issues](https://github.com/flucassena/gearmod/issues), or by e-mail to sena.franciscolucas@gmail.com. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License and trademarks

- Code: [PolyForm Shield License 1.0.0](LICENSE.md). See also [NOTICE](NOTICE).
- Third-party packages keep their own licenses; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- The GearMod name and logo are not covered by the code license; see [TRADEMARKS.md](TRADEMARKS.md).
- Claude Code, Codex and other product names belong to their owners. GearMod is not affiliated with Anthropic or OpenAI.
