# Starts the till's server in the background, and keeps its log.
#
# Run by the "Front Desk POS" scheduled task at every logon. Also fine to run by
# hand if the shop has stopped it and wants it back without a restart.

$ErrorActionPreference = 'Stop'

$Repo    = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$DataDir = Join-Path $env:LOCALAPPDATA 'FrontDeskPOS'
$EnvFile = Join-Path $DataDir 'pos.env'
$LogFile = Join-Path $DataDir 'server.log'

if (-not (Test-Path $EnvFile)) { throw "No settings at $EnvFile — run install.ps1 first." }

# Already answering? Then there is nothing to do. Two copies of the server on
# one database is the one arrangement that can genuinely corrupt it.
try {
  $r = Invoke-WebRequest -Uri 'http://localhost:4000/api/health' -UseBasicParsing -TimeoutSec 2
  if ($r.StatusCode -eq 200) { exit 0 }
} catch { }

# The settings file is plain KEY=value, which is all the server wants.
Get-Content $EnvFile | ForEach-Object {
  if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') {
    [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim(), 'Process')
  }
}

# Rolled rather than grown for ever: this file is the only account of what
# happened on a morning when the till would not start, and a 400 MB one is no
# account at all.
if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 5MB)) {
  Move-Item $LogFile "$LogFile.old" -Force
}

Start-Process -FilePath 'node' `
  -ArgumentList 'src/index.js' `
  -WorkingDirectory (Join-Path $Repo 'server') `
  -WindowStyle Hidden `
  -RedirectStandardOutput $LogFile `
  -RedirectStandardError "$LogFile.err"
