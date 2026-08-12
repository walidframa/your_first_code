# Front Desk POS, on a Windows PC in the shop.
#
#   Right-click "Install Front Desk.cmd" -> Run as administrator
#   (or: powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1)
#
# This is the *other* way to run the app: the server on the shop's own computer
# rather than on a machine in a data centre. Pick one. Two servers means two
# stock figures, and the day they disagree is the day nobody trusts either.
#
# It is the right choice when the shop's internet or power is unreliable — the
# till keeps working with the line down, because nothing it needs is outside the
# building. It is the wrong choice if you want to look at today's takings from
# home, unless you also put a tunnel in front of it.
#
# Safe to run twice. Installs what is missing, leaves alone what is there, and
# never touches the database or the secrets once they exist.

#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

function Say  ($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Note ($m) { Write-Host "    $m" -ForegroundColor DarkGray }
function Die  ($m) { Write-Host "`n!! $m" -ForegroundColor Red; exit 1 }

# The repo is two folders up from this script, however the shop got it there.
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not (Test-Path (Join-Path $Repo 'package.json'))) {
  Die "This does not look like the app's folder: $Repo"
}

# The books live outside the checkout, so that pulling an update — or deleting
# the folder and starting again — can never take the shop's history with it.
$DataDir = Join-Path $env:LOCALAPPDATA 'FrontDeskPOS'
$DbPath  = Join-Path $DataDir 'data.sqlite'
$EnvFile = Join-Path $DataDir 'pos.env'
$BackupDir = Join-Path $DataDir 'backups'

New-Item -ItemType Directory -Force -Path $DataDir, $BackupDir | Out-Null

# ------------------------------------------------------------ Node and Git

Say "Checking what this computer already has"

function Have ($name) { $null -ne (Get-Command $name -ErrorAction SilentlyContinue) }

function NodeMajor {
  if (-not (Have 'node')) { return 0 }
  try { [int]((& node -p 'process.versions.node.split(".")[0]') 2>$null) } catch { 0 }
}

if ((NodeMajor) -lt 24) {
  if (-not (Have 'winget')) {
    Die "Node 24 or newer is needed and winget is not available. Install Node from https://nodejs.org (choose the LTS that is 24 or above), then run this again."
  }
  Note "Installing Node 24 (this takes a couple of minutes)"
  winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
  # winget puts it on the PATH for *new* windows, not this one.
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}
if ((NodeMajor) -lt 24) {
  Die "Node is still not 24 or newer. Close this window, open a new one, and run the installer again."
}
Note "node $(& node -v)"

if (-not (Have 'git')) {
  if (Have 'winget') {
    Note "Installing Git"
    winget install --id Git.Git --silent --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
  } else {
    Note "No Git — updates will have to be downloaded by hand rather than pulled"
  }
}

# --------------------------------------------------------------- the secrets

#
# Written once and never again.
#
# JWT_SECRET changing logs everybody out, which is a nuisance. ACCOUNT_SECRET
# changing makes every customer password and repair passcode the shop is holding
# unreadable, permanently — so an installer that refreshed this file on its
# second run would quietly destroy the most sensitive thing in the database.
#
if (Test-Path $EnvFile) {
  Say "Keeping the settings already in $EnvFile"
} else {
  Say "Writing $EnvFile with fresh secrets"
  function NewKey { & node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))' }
  @(
    "NODE_ENV=production",
    "PORT=4000",
    "DB_PATH=$($DbPath -replace '\\','/')",
    "JWT_SECRET=$(NewKey)",
    "ACCOUNT_SECRET=$(NewKey)",
    "TAX_RATE=0",
    "BACKUP_DIR=$($BackupDir -replace '\\','/')",
    "BACKUP_KEEP=30"
  ) | Set-Content -Path $EnvFile -Encoding UTF8
  Note "ACCOUNT_SECRET is in that file. Copy it onto a USB stick today — a backup"
  Note "restored without it is a backup with every stored password gone for good."
}

# ------------------------------------------------------------------- build

Say "Installing and building (a few minutes the first time)"
Push-Location $Repo
try {
  & npm run setup
  if ($LASTEXITCODE -ne 0) { Die "npm run setup failed" }
  & npm run build
  if ($LASTEXITCODE -ne 0) { Die "The build failed" }

  # The shop's own database is a different file from the one `setup` seeded next
  # to the code, and a brand-new one has no users in it — so without this the
  # app comes up perfectly and nobody can sign in. Skips whatever is already
  # there, so it is safe every time.
  Say "Making sure there is an owner to sign in as"
  $env:DB_PATH = $DbPath
  & npm run seed
  if ($LASTEXITCODE -ne 0) { Die "Seeding failed" }
} finally {
  Pop-Location
  Remove-Item Env:\DB_PATH -ErrorAction SilentlyContinue
}

# ------------------------------------------------- start it, and keep it up

# A scheduled task rather than a service: it needs no extra software, it
# survives a reboot, and a shopkeeper can see and stop it in Task Scheduler
# without needing anybody's help.
Say "Setting it to start with the computer"

$startScript = Join-Path $PSScriptRoot 'start-server.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName 'Front Desk POS' -Action $action -Trigger $trigger `
  -Settings $settings -Description 'Runs the shop till in the background' -Force | Out-Null

Start-ScheduledTask -TaskName 'Front Desk POS'

# ------------------------------------------------------------- the shortcut

#
# A shortcut that opens the till in its own window.
#
# `--app=` is the browser's own way of running a page as an application: no
# address bar, no tabs, its own button on the taskbar. It is the same thing the
# Install button inside Settings produces, available before anybody has found
# that button.
#
Say "Putting Front Desk on the desktop"

$browser = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$desktop = [Environment]::GetFolderPath('Desktop')
$link = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop 'Front Desk.lnk'))
if ($browser) {
  $link.TargetPath = $browser
  $link.Arguments = '--app=http://localhost:4000'
} else {
  # No Chrome or Edge found, so hand it to whatever opens web pages here. It
  # will be a tab rather than a window of its own, which still sells.
  $link.TargetPath = 'http://localhost:4000'
  Note "Chrome or Edge not found — the shortcut opens in the default browser instead"
}
# A real .ico, because a Windows shortcut cannot use the SVG the browser uses.
$link.IconLocation = (Join-Path $Repo 'client\public\favicon.ico')
$link.Description = 'The shop till'
$link.Save()

# ------------------------------------------------------------------- proof

Say "Waiting for it to answer"
$ok = $false
foreach ($i in 1..30) {
  try {
    $r = Invoke-WebRequest -Uri 'http://localhost:4000/api/health' -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { Start-Sleep -Seconds 1 }
}

if (-not $ok) {
  Die "It did not come up. Look at $DataDir\server.log for what it said."
}

Write-Host "`n==> Front Desk is running on this computer" -ForegroundColor Green
Write-Host @"

Open it with the "Front Desk" icon on the desktop, or go to http://localhost:4000

Three things to do now:

  1. Sign in as admin / admin123 and change both passwords.

  2. Copy ACCOUNT_SECRET out of
     $EnvFile
     onto a USB stick or into a password manager. It is the only thing that can
     read the customer passwords back out of a backup.

  3. The till on other devices in the shop: find this computer's address with
     'ipconfig' and open http://<that-address>:4000 on the tablet. You may have
     to allow Node through Windows Firewall the first time.

To take an update later: right-click "Update Front Desk.cmd" -> Run as administrator

"@ -ForegroundColor Gray
