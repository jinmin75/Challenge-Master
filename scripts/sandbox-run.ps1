# Runs inside a disposable Windows Sandbox, launched by scripts/run-sandbox.mjs via wsb exec.
# C:\cm\in is mapped read-only (installer + smoke script); C:\cm\out is the only writable host folder.
$ErrorActionPreference = 'Continue'
$in = 'C:\cm\in'
$out = 'C:\cm\out'
Start-Transcript -Path (Join-Path $out 'transcript.txt') | Out-Null

function Find-Command($name) {
  $found = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { return $found.Source }
  return $null
}

function Get-SmartAppControlState {
  try {
    $value = Get-ItemPropertyValue 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' 'VerifiedAndReputablePolicyState' -ErrorAction Stop
    return [int]$value
  } catch {
    return $null
  }
}

function Invoke-Phase($label, $mode) {
  $installer = Get-ChildItem $in -Filter 'Challenge-Master-Setup-*-win-x64.exe' | Select-Object -First 1
  $installRoot = Join-Path $env:LOCALAPPDATA 'Programs\ChallengeMaster'
  $setup = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
  $result = [ordered]@{ label = $label; installExit = $setup.ExitCode; installRoot = $installRoot }
  if ($setup.ExitCode -ne 0) { return $result }
  $env:CHALLENGE_MASTER_DISPOSABLE_VM = '1'
  # The sandbox has no Node.js, so borrow the bundled one. Run a copy: while the test itself
  # executes the installed node.exe, the uninstaller correctly treats the app as running.
  $runner = Join-Path $env:TEMP 'cm-smoke-node'
  New-Item -ItemType Directory -Force $runner | Out-Null
  $node = Join-Path $runner 'node.exe'
  Copy-Item (Join-Path $installRoot 'runtime\node\node.exe') $node -Force
  $output = & $node (Join-Path $in 'smoke-installer.mjs') $installRoot $mode 2>&1 | Out-String
  $result.smokeExit = $LASTEXITCODE
  $result.smokeOutput = $output
  return $result
}

$report = [ordered]@{
  startedAt = (Get-Date).ToString('o')
  os = (Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSLanguage)
  user = $env:USERNAME
  # Evidence that no developer runtime is on PATH before installation.
  nodeOnPath = Find-Command 'node'
  pythonOnPath = Find-Command 'python'
  smartAppControlState = Get-SmartAppControlState
  # Evidence that the app ran offline: no IPv4 address other than loopback or link-local.
  routableIPv4 = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    ForEach-Object { $_.IPAddress })
  phases = @()
}
$report.phases += Invoke-Phase 'preserve-records' '--uninstall'
$report.phases += Invoke-Phase 'delete-records' '--uninstall-delete-data'
$report.finishedAt = (Get-Date).ToString('o')
$report.passed = @($report.phases | Where-Object { $_.installExit -ne 0 -or $_.smokeExit -ne 0 }).Count -eq 0

# The host parses this with JSON.parse, so write UTF-8 without a BOM.
$json = $report | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path $out 'result.json'), $json, (New-Object System.Text.UTF8Encoding $false))
Stop-Transcript | Out-Null
# The host (scripts/run-sandbox.mjs) stops the sandbox after reading result.json.
