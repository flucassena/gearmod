# Waits until no agent (or automated test) is working in the GearMod data, so closing the app does not cut a run.
# Dot-source it and call Wait-AgentsIdle before Stop-Process.
function Wait-AgentsIdle {
  param([string[]]$Databases = @((Join-Path $env:APPDATA 'GearMod\data\gearmod.sqlite'), (Join-Path $env:APPDATA 'GearMod-test\data\gearmod.sqlite')))
  $probe = Join-Path $PSScriptRoot 'agents-busy.mjs'
  $warned = $false
  while ($true) {
    $busy = 0
    foreach ($database in $Databases) {
      $count = node --no-warnings $probe $database 2>$null
      if ($LASTEXITCODE -ne 0) { throw 'Could not check whether agents are working (node scripts/agents-busy.mjs failed). Close GearMod yourself.' }
      $busy += [int]$count
    }
    if ($busy -eq 0) { return }
    if (-not $warned) { Write-Host "$busy agent run(s) working in GearMod: waiting for them to finish before closing it..."; $warned = $true }
    Start-Sleep -Seconds 10
  }
}
