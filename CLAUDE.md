# GearMod

## Build

Don't build when you finish a task. Run a build only when the user asks for one. When they do, run it from the project root:

```powershell
# Quick build: an executable to test, without the installer.
powershell -ExecutionPolicy Bypass -File .\build.ps1

# Distribution build: the NSIS installer.
powershell -ExecutionPolicy Bypass -File .\installer.ps1
```

- `build.ps1` installs dependencies, builds `apps/desktop/dist/win-unpacked/GearMod.exe` and prints its path and time.
- `installer.ps1` installs dependencies, runs `pnpm dist` and prints the path and time of the installer it built (`apps/desktop/dist/GearMod-Setup-0.3.0-x64.exe`).
- An open test build (`apps/desktop/dist/win-unpacked`) locks the folder and the build fails. Both scripts stop with an error instead of closing it; `-Force` closes it.
- If the build fails, say so in the final summary, with the error. Don't say the build was produced without checking the `.exe` time.

## Never close GearMod on your own

The test build and the stable install share the user's data, and agents may be working in either one. Closing GearMod cuts those runs (they end as "interrupted"). `build.ps1`, `installer.ps1`, `test.ps1` and `promote.ps1` stop when the app they would close is open. Never pass `-Force` without asking the user first, saying which app will close. With `-Force` the scripts wait until no agent or automated test is working (`scripts/wait-agents-idle.ps1`, which reads `runs`/`test_runs` through `scripts/agents-busy.mjs`), then close the app; run them in the background, since the wait can be long.

## Running the build

- `test.ps1` ("homolog") opens the current build with the stable install's data (`%APPDATA%\GearMod`); it stops if the stable install is open (see above): the user tests on their own cards. A build with a new database migration upgrades that data, so the stable install only opens it again after `promote.ps1`; say so when that happens.
- `test.ps1 -Isolated` opens the separate `test` profile (data in `%APPDATA%\GearMod-test`), alongside the stable install. `-Isolated -CopyData` first copies the stable data into it (without the card worktrees). Use it only when the user asks for a more isolated version.
- `promote.ps1` copies the current build to the stable install in `C:\GearMod-stable` and opens it; it stops if the stable install is open. The stable data in `%APPDATA%\GearMod` is not touched.

## Releases

When the user asks for a release, do the whole process:

1. Pick the next version (minor for new features, patch for fixes only) and set it in `package.json`, `apps/desktop/package.json` and `packages/contracts/package.json`; the tag example in `README.md`, `README.pt-BR.md` and the installer name above follow it.
2. Write the release notes in `release-notes/<version>.md` (English) **and** `release-notes/<version>.pt-BR.md` (Portuguese), in the format of the previous versions, with everything since the last tag (`git log v<last>..dev`). The download page of the site reads both; the Release body and the app's About tab use the English one.
3. Commit them as `improvement: Prepare version <version> with its release notes`, push `dev`, fast-forward `main` to `dev` and push `main`.
4. Create the annotated tag `v<version>` on that commit with the English notes as its message, and push it. The tag starts `release.yml` (it checks that the tag matches `apps/desktop/package.json`, builds and publishes the Windows, Linux and Mac packages), which then starts `pages.yml` so the site lists the new version and its notes.
5. Before tagging, run `pnpm typecheck`, `pnpm lint` and `pnpm test`: the release runs them and publishes nothing if one fails. Say in the summary whether the workflows finished; don't say the release is out without checking it on GitHub.
