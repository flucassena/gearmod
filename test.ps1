# Opens the TEST build (the current apps\desktop\dist\win-unpacked).
# Usage: .\test.ps1                      opens it with the stable install's data (%APPDATA%\GearMod); stops if the stable install is open
#        .\test.ps1 -Force               same, closing an open stable install first (waits for working agents to finish)
#        .\test.ps1 -Isolated            opens the separate "test" profile (data in %APPDATA%\GearMod-test), alongside the stable install
#        .\test.ps1 -Isolated -CopyData  first copies the stable install's data into the test profile (overwrites the test data)
# With the stable data, a build with a new database migration upgrades that data: the stable install only opens it again after promote.ps1.
param([switch]$Isolated, [switch]$CopyData, [switch]$Force)
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'apps\desktop\dist\win-unpacked\GearMod.exe'
if (-not (Test-Path $exe)) { throw "Build not found: $exe (run build.ps1)" }
if ($CopyData -and -not $Isolated) { throw '-CopyData only applies with -Isolated.' }

if (-not $Isolated) {
  # Same data folder means the same single-instance lock: the stable install has to be closed for the test build to open.
  $stable = Get-Process -Name GearMod -ErrorAction SilentlyContinue | Where-Object { $_.Path -and -not $_.Path.StartsWith((Split-Path $exe), [StringComparison]::OrdinalIgnoreCase) }
  if ($stable) {
    if (-not $Force) { throw 'The stable install is open and uses the same data. Close it yourself or run again with -Force (it waits for working agents, then closes).' }
    . (Join-Path $PSScriptRoot 'scripts\wait-agents-idle.ps1'); Wait-AgentsIdle
    Write-Host 'Closing the stable install (it uses the same data)...'
    $stable | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  Remove-Item Env:GEARMOD_PROFILE -ErrorAction SilentlyContinue
  Start-Process -FilePath $exe
  Write-Host "Test build opened with the stable data ($(Join-Path $env:APPDATA 'GearMod'))."
  return
}

$testDir = Join-Path $env:APPDATA 'GearMod-test'
if ($CopyData) {
  $source = Join-Path $env:APPDATA 'GearMod\data'
  if (-not (Test-Path $source)) { throw "Stable install data not found: $source" }
  $open = Get-Process -Name GearMod -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith((Split-Path $exe), [StringComparison]::OrdinalIgnoreCase) }
  if ($open) { throw 'The test build is open; close it before copying the data.' }
  Remove-Item (Join-Path $testDir 'data') -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $testDir | Out-Null
  # Card worktrees (wt) are left out: they are big (node_modules) and the copied database would point at the stable ones anyway.
  robocopy $source (Join-Path $testDir 'data') /E /XD (Join-Path $source 'wt') /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit code $LASTEXITCODE)" }
  Write-Host 'Stable install data copied to the test profile.'
}

# The test profile used to be called "teste". Its folder is not renamed, because worktree paths are stored inside it.
$oldTestDir = Join-Path $env:APPDATA 'GearMod-teste'
if (Test-Path $oldTestDir) { Write-Host "The old test profile in $oldTestDir is no longer used. Delete it when you no longer need it; use -Isolated -CopyData to start the new one from the stable data." }

$env:GEARMOD_PROFILE = 'test'
Start-Process -FilePath $exe
Write-Host "Test build opened (data in $testDir)."
