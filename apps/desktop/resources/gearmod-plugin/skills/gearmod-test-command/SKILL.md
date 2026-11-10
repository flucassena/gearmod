---
name: gearmod-test-command
description: Sets up the automated-test command of each repository of the project (Project settings > Testes), with a short name, or marks a repository as having no tests. Use in the project's automated-tests chat, or when the user asks to configure, fix or change the test commands.
---

# Configure the automated tests of the project (GearMod)

Write everything you produce for the user — questions, the names you choose and chat replies — in the language given in `idioma` (e.g. `pt-BR`, `en`). These instructions are in English; that does not change the output language.

Each repository of the project has its own test command, used by **every card of the project**. When the user clicks "Testes automatizados" in a card's Changes panel, GearMod runs, one after the other, the command of **each repository the card changed**, and the card passes when all of them pass. Repositories the card did not change, and repositories marked as having no tests, are skipped. Think about each repository as a whole, never about one card.

## How GearMod runs each command

- Through the system shell (`cmd.exe` on Windows, `sh` on macOS/Linux), with the **current folder set to that repository's folder inside the card's worktree**. So `npm test`, `npx ...`, `pnpm ...` and `&&` work. PowerShell syntax (`$env:X`, `;` as separator, `Get-ChildItem`) does not, unless you call `powershell -NoProfile -File <script>`.
- It also receives: `GEARMOD_WORKTREE` (root of the card's worktree), `GEARMOD_REPO` (repository name), `GEARMOD_REPO_PATH` (this repository's folder in the worktree) and `GEARMOD_CARD_ID`.
- 10-minute limit per repository. Only the exit code matters (0 passes). It must run once and exit: no watch mode, no prompt.

## Steps

1. **List the repositories.** Call `gearmod_test_command` without arguments: it shows each repository and what is already set.
2. **Look at each repository** (in the project folder): `package.json` scripts, `Makefile`, `pyproject.toml`, `*.csproj`/`*.sln`, `go.mod`, CI files (`.github/workflows`, `azure-pipelines.yml`, `.gitlab-ci.yml`), docker-compose files and the README. Prefer what CI runs.
3. **Choose, per repository, the simplest command that runs from that repository's own folder:**
   - It has a test script: use it, with the flags needed to run once (`npm test -- --watchAll=false`, `pnpm test`, `python -m pytest`, `dotnet test`, `go test ./...`).
   - It needs several steps, containers or environment variables: create a script **inside that repository** (e.g. `scripts/gearmod-test.ps1` or `.sh`), referenced by a **relative path** (`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gearmod-test.ps1`). Ask the user before creating it, and say it must be committed to reach the cards' worktrees (the worktree comes from the base branch). Never save absolute paths, `%USERPROFILE%` files or paths to a card's worktree.
   - It has no automated tests (docs, infrastructure, assets, a front end with no test setup): mark it with `aplicavel: false`. It does not hold Done.
4. **Confirm with the user** when you had to guess (several candidates, a script to create, Docker or slow suites). Show the plan as a short list: repository → name → command, or "no tests". Do not ask when every repository's own test script is obvious.
5. **Check each command once** from that repository's folder (in a card worktree if one exists, otherwise in the project folder): it must finish with exit code 0, or explain why it fails (missing dependency, container not running). Do not save a command you know is broken without saying so.
6. **Save** each repository with `gearmod_test_command`: `repositorio` + `comando` + `nome`, or `repositorio` + `aplicavel: false`. `nome` is a short label shown in the panel, up to about 20 characters, saying what runs (`Jest`, `Pytest`, `xUnit`). Never put the command in `nome`.
7. **Reply** with the final list (repository → name → command, or no tests) and, if you created scripts, where they are and that they need to be committed.

## Do not

- Do not save long one-liners: if it does not fit comfortably in one short line, it belongs in a script inside the repository.
- Do not loop over repositories inside one command: GearMod already runs each repository separately, only when the card changed it.
- Do not change application code or tests to make them pass; that is not this task.
- Do not run "Testes automatizados" or move cards: that is the user's click.
