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
- `installer.ps1` installs dependencies, runs `pnpm dist` and prints the path and time of the installer it built (`apps/desktop/dist/GearMod-Setup-0.2.0-x64.exe`).
- Both close any running `GearMod.exe` from `apps/desktop/dist/win-unpacked`, because that process locks the folder and the build fails.
- If the build fails, say so in the final summary, with the error. Don't say the build was produced without checking the `.exe` time.

## Running the build

- `test.ps1` opens the current build with the `test` profile (data in `%APPDATA%\GearMod-test`). `-CopyData` first copies the stable install's data into it.
- `promote.ps1` copies the current build to the stable install in `C:\GearMod-stable` and opens it. The stable data in `%APPDATA%\GearMod` is not touched.
