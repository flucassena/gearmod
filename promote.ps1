# Promotes the current build (win-unpacked) to the STABLE install in C:\GearMod-stable and opens it.
# The stable install's data lives in %APPDATA%\GearMod and is not touched; only the program files are replaced.
# Usage: .\promote.ps1          stops if GearMod is open (agents working in it would be cut)
#        .\promote.ps1 -Force   closes it first, after waiting for working agents to finish
param([switch]$Force)
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'apps\desktop\dist\win-unpacked'
$target = 'C:\GearMod-stable'
# Older versions of this script installed here. That folder holds only program files, so it is removed after the move.
$oldTarget = 'C:\GearMod-homologado'
if (-not (Test-Path (Join-Path $source 'GearMod.exe'))) { throw "Build not found in $source (run build.ps1)" }

# Close only the stable install (the test build runs from another folder and stays open).
$running = Get-Process -Name GearMod -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path.StartsWith($target, [StringComparison]::OrdinalIgnoreCase) -or $_.Path.StartsWith($oldTarget, [StringComparison]::OrdinalIgnoreCase)) }
if ($running) {
  if (-not $Force) { throw 'The stable install is open. Close it yourself or run again with -Force (it waits for working agents, then closes).' }
  . (Join-Path $PSScriptRoot 'scripts\wait-agents-idle.ps1'); Wait-AgentsIdle
  Write-Host 'Closing the current stable install...'
  # Some app process may already have exited between listing and stopping: that is not an error.
  $running | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

New-Item -ItemType Directory -Force $target | Out-Null
robocopy $source $target /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit code $LASTEXITCODE)" }

if (Test-Path (Join-Path $oldTarget 'GearMod.exe')) {
  Remove-Item $oldTarget -Recurse -Force
  Write-Host "Removed the old install folder $oldTarget. Update any shortcut to $target\GearMod.exe."
}

Start-Process -FilePath (Join-Path $target 'GearMod.exe')
Get-Item (Join-Path $target 'GearMod.exe') | Select-Object FullName, LastWriteTime
