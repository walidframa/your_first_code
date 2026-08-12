# Take an update, on a shop PC.
#
#   Right-click "Update Front Desk.cmd" -> Run as administrator
#
# Backs up the database first, pulls, rebuilds, restarts, and then waits until
# the app actually answers before saying it worked — a deploy that finished is
# not the same thing as a shop that is serving.
#
# It is a command somebody chooses to run, not something that happens by itself,
# because a restart drops whoever is mid-sale back to a loading screen. That
# should be the decision of the person standing at the counter.

#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

function Say  ($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Note ($m) { Write-Host "    $m" -ForegroundColor DarkGray }
function Die  ($m) { Write-Host "`n!! $m" -ForegroundColor Red; exit 1 }

$Repo    = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$DataDir = Join-Path $env:LOCALAPPDATA 'FrontDeskPOS'
$DbPath  = Join-Path $DataDir 'data.sqlite'
$Backups = Join-Path $DataDir 'backups'

# ------------------------------------------------------------- the backup

# First, because the whole shop is in this one file and the moment you want
# yesterday's copy is exactly the moment you can no longer make one.
if (Test-Path $DbPath) {
  Say "Backing up the database"
  New-Item -ItemType Directory -Force -Path $Backups | Out-Null
  $stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
  $out = Join-Path $Backups "data-$stamp.sqlite"

  # SQLite's own copy, not a file copy: copying a live database that is mid-write
  # can produce a file that will not open, and you find that out on the day you
  # need it.
  Push-Location (Join-Path $Repo 'server')
  try {
    $env:DB_PATH = $DbPath
    & node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.DB_PATH,{readOnly:true});d.exec(``VACUUM INTO '$($out -replace '\\','/')'``);d.close()"
    if ($LASTEXITCODE -ne 0) { Die "The backup failed, so nothing else was touched." }
  } finally {
    Pop-Location
    Remove-Item Env:\DB_PATH -ErrorAction SilentlyContinue
  }
  Note (Split-Path $out -Leaf)
}

# --------------------------------------------------------------- the code

Push-Location $Repo
try {
  if (Test-Path (Join-Path $Repo '.git')) {
    # Somebody editing files directly on the shop's computer is the usual cause
    # of a failed update. Pulling over that work either fails or throws it away,
    # and both are worse than stopping to say so.
    & git diff --quiet
    if ($LASTEXITCODE -ne 0) {
      & git status --short
      Die "There are edited files here. Undo or commit them first."
    }

    Say "Fetching the latest version"
    $before = (& git rev-parse HEAD)
    & git fetch origin main
    & git merge --ff-only origin/main
    if ($LASTEXITCODE -ne 0) { Die "Cannot fast-forward — this copy has diverged from main." }
    $after = (& git rev-parse HEAD)
    if ($before -eq $after) { Note "Already up to date" }
  } else {
    Note "Not a git checkout, so nothing to pull — rebuilding what is here"
  }

  Say "Installing and building"
  & npm install --no-audit --fund=false
  if ($LASTEXITCODE -ne 0) { Die "npm install failed" }
  & npm --prefix server install --no-audit --fund=false
  if ($LASTEXITCODE -ne 0) { Die "npm install failed in server" }
  & npm --prefix client install --no-audit --fund=false
  if ($LASTEXITCODE -ne 0) { Die "npm install failed in client" }
  & npm run build
  if ($LASTEXITCODE -ne 0) { Die "The build failed — the old version is still running." }
} finally {
  Pop-Location
}

# ------------------------------------------------------------- the restart

# The database migrates itself when the server boots, so there is no separate
# step for that — but it also means the new code and the old file meet here for
# the first time, which is why the backup above happens before any of this.
Say "Restarting"
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*src\index.js*' -or $_.CommandLine -like '*src/index.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Start-Sleep -Seconds 1
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-server.ps1')

Say "Waiting for it to answer"
$ok = $false
foreach ($i in 1..30) {
  try {
    $r = Invoke-WebRequest -Uri 'http://localhost:4000/api/health' -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { Start-Sleep -Seconds 1 }
}

if (-not $ok) {
  Die "It did not come back up. Look at $DataDir\server.log. The database was backed up before any of this — the copies are in $Backups."
}

Write-Host "`n==> Updated and serving" -ForegroundColor Green
Write-Host "    Everyone's till picks it up on the next reload.`n" -ForegroundColor DarkGray
