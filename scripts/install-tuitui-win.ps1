<#
.SYNOPSIS
  One-click installer for the TuiTui (推推) channel on Windows.

.DESCRIPTION
  Flow: environment check -> upstream dependency setup -> config generation
        -> build -> start -> verify WS connection.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\install-tuitui-win.ps1 [-AutoApprove] [-Workdir DIR] [-Interactive] [-CtiHome DIR]

  Credentials come from (priority): existing config > env vars > interactive prompt.
    Env vars: CTI_TUITUI_APPID / CTI_TUITUI_SECRET / CTI_TUITUI_BOT_NAME
  Upstream dependency repo (override with env CTI_UPSTREAM_REPO):
    default https://github.com/bbfe-ai/Claude-to-IM

  Day-to-day management (already provided by upstream):
    powershell -File scripts\daemon.ps1 start|stop|status|logs
    powershell -File scripts\daemon.ps1 install-service   # WinSW/NSSM autostart service
#>
param(
    [switch]$AutoApprove,
    [string]$Workdir = '',
    [switch]$Interactive,
    [string]$CtiHome = ''
)

$ErrorActionPreference = 'Stop'

# ── Paths ──
$SkillDir  = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$CtiHome   = if ($CtiHome) { $CtiHome } elseif ($env:CTI_HOME) { $env:CTI_HOME } else { Join-Path $env:USERPROFILE '.claude-to-im' }
$Config    = Join-Path $CtiHome 'config.env'
$LogFile   = Join-Path $CtiHome 'logs' 'bridge.log'
$DistMjs   = Join-Path $SkillDir 'dist' 'daemon.mjs'
$CtiEnvArg = if ($CtiHome -ne (Join-Path $env:USERPROFILE '.claude-to-im')) { "CTI_HOME=$CtiHome" } else { $null }

function Write-Step([string]$msg) { Write-Host "==> $msg" }

# ── 1. Environment check ──
Write-Step 'Checking environment...'
function Test-Command([string]$name) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "Missing $name. Please install it first." }
    return $cmd
}
$node = Test-Command 'node'
$nodeMajor = [int]((& $node.Source -e "console.log(process.versions.node.split('.')[0])") -join '')
if ($nodeMajor -lt 20) { throw "Node.js >= 20 required (found $( & $node.Source -v ))." }
Test-Command 'claude' | Out-Null
Test-Command 'git' | Out-Null
Write-Host "     Node $( & $node.Source -v ) / claude CLI / git OK"

# ── 2. Upstream dependency setup ──
Write-Step 'Checking dependencies...'
$UpstreamDir = Join-Path (Split-Path -Parent $SkillDir) 'Claude-to-IM'
if (Test-Path (Join-Path $SkillDir 'node_modules\claude-to-im')) {
    Write-Host '     Dependencies ready (node_modules\claude-to-im exists).'
} elseif (Test-Path $UpstreamDir) {
    Write-Host "     Upstream repo found at $UpstreamDir, running npm install..."
    Push-Location $SkillDir
    npm install
    Pop-Location
} else {
    $UpstreamRepo = if ($env:CTI_UPSTREAM_REPO) { $env:CTI_UPSTREAM_REPO } else { 'https://github.com/bbfe-ai/Claude-to-IM' }
    Write-Host "     Cloning upstream dependency $UpstreamRepo ..."
    git clone --depth 1 $UpstreamRepo $UpstreamDir
    Push-Location $SkillDir
    npm install
    Pop-Location
}

# ── 3. Config generation ──
Write-Step "Config ($Config)"
New-Item -ItemType Directory -Path $CtiHome -Force | Out-Null
if (-not (Test-Path $Config)) { New-Item -ItemType File -Path $Config -Force | Out-Null }

function Add-LineIfMissing([string]$Key, [string]$Value) {
    if (-not (Select-String -Path $Config -Pattern "^$Key=" -Quiet)) {
        Add-Content -Path $Config -Value "$Key=$Value" -Encoding UTF8
    }
}
Add-LineIfMissing 'CTI_RUNTIME' 'claude'
Add-LineIfMissing 'CTI_ENABLED_CHANNELS' 'tuitui'
$defaultWorkdir = if ($Workdir) { $Workdir } else { Join-Path $env:USERPROFILE 'agent-workspace' }
Add-LineIfMissing 'CTI_DEFAULT_WORKDIR' $defaultWorkdir
if ($AutoApprove) { Add-LineIfMissing 'CTI_AUTO_APPROVE' 'true' }
Add-LineIfMissing 'CTI_TUITUI_API_BASE' 'https://alarm.im.qihoo.net'
Add-LineIfMissing 'CTI_TUITUI_CARD_URL' 'https://intent-os.qihoo.net'
Add-LineIfMissing 'CTI_TUITUI_MEDIA_ENABLED' 'true'

function Set-Cred([string]$Key, [string]$Prompt) {
    if (Select-String -Path $Config -Pattern "^$Key=" -Quiet) { return }
    $value = [System.Environment]::GetEnvironmentVariable($Key)
    if (-not $value -and $Interactive) {
        $value = Read-Host -Prompt $Prompt
    }
    if (-not $value) { throw "Missing credential $Key (set env var $Key, or re-run with -Interactive)." }
    Add-Content -Path $Config -Value "$Key=$value" -Encoding UTF8
}
Set-Cred 'CTI_TUITUI_APPID' 'TuiTui App ID'
Set-Cred 'CTI_TUITUI_SECRET' 'TuiTui Secret'
Set-Cred 'CTI_TUITUI_BOT_NAME' 'TuiTui bot name'

# ── 4. Build ──
Write-Step 'Building daemon bundle...'
Push-Location $SkillDir
npm run build
Pop-Location
if (-not (Test-Path $DistMjs)) { throw "Build failed: $DistMjs not found." }

# ── 5. Start (reuse upstream daemon.ps1) ──
Write-Step 'Starting bridge (supervisor-windows.ps1)...'
$DaemonPs1 = Join-Path $SkillDir 'scripts' 'daemon.ps1'
if ($CtiEnvArg) { $env:CTI_HOME = $CtiHome }
& powershell -ExecutionPolicy Bypass -File $DaemonPs1 start
if ($LASTEXITCODE -ne 0) { throw "daemon.ps1 start failed (exit $LASTEXITCODE)." }

# ── 6. Verify WS connection (up to 20s) ──
Write-Step 'Verifying TuiTui WS connection...'
$connected = $false
for ($i = 0; $i -lt 20; $i++) {
    if (Test-Path $LogFile) {
        $tail = Get-Content -Path $LogFile -Tail 30 -ErrorAction SilentlyContinue -Raw
        if ($tail -match '\[tuitui-ws\] 连接成功') { $connected = $true; break }
    }
    Start-Sleep -Seconds 1
}
if ($connected) {
    Write-Host ''
    Write-Host 'OK - TuiTui WS connected. Deployment successful.'
} else {
    Write-Host ''
    Write-Host 'WARNING: did not see "tuitui-ws 连接成功" in the log within 20s.'
    Write-Host "  Log: $LogFile"
    Write-Host '  Check: powershell -File scripts\daemon.ps1 logs 50'
    exit 1
}

# ── Summary ──
Write-Host ''
Write-Host '┌─ Management ────────────────────────────────────────────'
Write-Host '│ Start:   powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 start'
Write-Host '│ Stop:    powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 stop'
Write-Host '│ Status:  powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 status'
Write-Host '│ Logs:    powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 logs 100'
Write-Host '│ Service: powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 install-service   (WinSW/NSSM autostart)'
Write-Host "│ Config:  $Config"
Write-Host "│ Workdir: $defaultWorkdir"
$perm = if ($AutoApprove) { 'auto-approve (CTI_AUTO_APPROVE=true)' } else { 'interactive card approval' }
Write-Host "│ Perm:    $perm"
Write-Host '└──────────────────────────────────────────────────────────'
Write-Host 'Full docs: references\tuitui-usage.md'