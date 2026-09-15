# ============================================================================
# ESP32-C3 DSH status light - one-command compile / upload helper
# ============================================================================
# Wraps the portable arduino-cli that ships inside the Arduino IDE bundle, so you
# do not have to open the IDE GUI at all.
#
# Usage:
#     powershell -ExecutionPolicy Bypass -File .\build.ps1            # compile only
#     powershell -ExecutionPolicy Bypass -File .\build.ps1 -Upload    # compile + upload
#     powershell -ExecutionPolicy Bypass -File .\build.ps1 -Monitor   # open serial monitor
#     powershell -ExecutionPolicy Bypass -File .\build.ps1 -Port COM7 -Upload
#
# NOTE: ASCII-only on purpose. Windows PowerShell 5.1 decodes .ps1 files without
# a BOM using the system ANSI codepage, which corrupts non-ASCII text.
# ============================================================================

[CmdletBinding()]
param(
    [switch]$Upload,
    [switch]$Monitor,
    [string]$Port = '',
    [int]$MonitorSeconds = 0
)

$ErrorActionPreference = 'Stop'

# --- paths -------------------------------------------------------------------
# ArduinoHome is intentionally absolute: the toolchain lives OUTSIDE this project
# (D:\Agent Workstation\arduino) because it is ~2 GB and shared by other ESP32
# projects. Everything else derives from $PSScriptRoot, so this whole project
# folder can be moved or renamed without editing this script.
$ArduinoHome = 'D:\Agent Workstation\arduino'
$Cli         = Join-Path $ArduinoHome 'Arduino-IDE\resources\app\lib\backend\resources\arduino-cli.exe'
$CliConfig   = Join-Path $ArduinoHome 'arduino-cli.yaml'
$RepoRoot    = Split-Path -Parent $PSScriptRoot
$Sketch      = Join-Path $RepoRoot 'firmware\esp32c3_dsh_status_light'
$BuildOut    = Join-Path $RepoRoot 'firmware\build'

# --- board options -----------------------------------------------------------
# Flash settings follow the vendor material in
#   ESP32-C3\ESP32-C3-MINI-1-V2.4.2.0\flasher_args.json
#   -> chip esp32c3, flash_mode dio, flash_freq 40m, flash_size 4MB
# CDCOnBoot=cdc is REQUIRED: without it the USB CDC serial port prints nothing.
$Fqbn = 'esp32:esp32:esp32c3' +
        ':CDCOnBoot=cdc' +
        ',FlashMode=dio' +
        ',FlashFreq=40' +
        ',FlashSize=4M' +
        ',PartitionScheme=default' +
        ',UploadSpeed=921600' +
        ',DebugLevel=none' +
        ',EraseFlash=none'

if (-not (Test-Path $Cli))      { throw "arduino-cli not found: $Cli" }
if (-not (Test-Path $Sketch))   { throw "sketch not found: $Sketch" }
New-Item -ItemType Directory -Force -Path $BuildOut | Out-Null

# Never let a dead proxy variable poison the download paths.
Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:http_proxy,Env:https_proxy -ErrorAction SilentlyContinue

Write-Host "FQBN: $Fqbn"

# --- compile -----------------------------------------------------------------
Write-Host ""
Write-Host "==> compile"
& $Cli --config-file $CliConfig compile --fqbn $Fqbn --output-dir $BuildOut --warnings none $Sketch
if ($LASTEXITCODE -ne 0) { throw "compile failed (exit $LASTEXITCODE)" }

Get-ChildItem $BuildOut -Filter '*.bin' | ForEach-Object {
    Write-Host ("    {0,-46} {1,8:N1} KB" -f $_.Name, ($_.Length / 1KB))
}

# --- upload ------------------------------------------------------------------
if ($Upload) {
    Write-Host ""
    Write-Host "==> upload"
    $args = @('--config-file', $CliConfig, 'upload', '--fqbn', $Fqbn)
    if ($Port -ne '') { $args += @('--port', $Port) }
    $args += $Sketch
    & $Cli @args
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "Upload failed. If the port is busy or wrong, try:" -ForegroundColor Yellow
        Write-Host "  1) close any serial monitor that holds the port"
        Write-Host "  2) hold BOOT, tap RST, release BOOT, then retry (forces download mode)"
        Write-Host "  3) list ports:  & '$Cli' board list"
        throw "upload failed (exit $LASTEXITCODE)"
    }
}

# --- monitor -----------------------------------------------------------------
if ($Monitor) {
    Write-Host ""
    Write-Host "==> serial monitor (type state names: thinking / busy / error / alarm / success / off)"
    $args = @('--config-file', $CliConfig, 'monitor', '--fqbn', $Fqbn, '--config', '115200')
    if ($Port -ne '') { $args += @('--port', $Port) }
    $args += $Sketch
    & $Cli @args
}

Write-Host ""
Write-Host "done."
