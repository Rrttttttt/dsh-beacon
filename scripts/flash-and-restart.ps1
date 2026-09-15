<#
.SYNOPSIS
    Flash the ESP32-C3 firmware and restart DSH (one command, unattended).

.DESCRIPTION
    Why this script exists:
      Flashing the firmware and running the plugin both need exclusive access to
      the SAME serial port (COM3). The plugin holds it open for as long as DSH is
      running, so esptool gets "port is busy" and cannot flash.

      Stopping DSH is therefore unavoidable -- but that also kills the agent
      session, so the agent cannot drive the rest. This script does the whole
      sequence unattended from a separate window:
        1. stop the DSH launcher process tree
        2. wait for COM3 to be released
        3. flash the firmware
        4. start DSH again in its own window

    Run it from a NEW terminal window (not the one running dsh web), or the
    script would kill its own console.

.PARAMETER Port
    Serial port of the board. Defaults to COM3.

.PARAMETER NoStart
    Flash only; do not start DSH afterwards.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\flash-and-restart.ps1
#>

[CmdletBinding()]
param(
    [string]$Port = 'COM3',
    [switch]$NoStart
)

$ErrorActionPreference = 'Continue'

function Write-Step { param([string]$m) Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "    [OK] $m" -ForegroundColor Green }
function Write-Warn2{ param([string]$m) Write-Host "    [!]  $m" -ForegroundColor Yellow }

# --- paths -------------------------------------------------------------------
# This script lives in <project>\scripts\, so the project root is one level up.
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ArduinoHome = 'D:\Agent Workstation\arduino'
$Cli      = Join-Path $ArduinoHome 'Arduino-IDE\resources\app\lib\backend\resources\arduino-cli.exe'
$CliConfig = Join-Path $ArduinoHome 'arduino-cli.yaml'
$Sketch   = Join-Path $RepoRoot 'firmware\esp32c3_dsh_status_light'

# Flash settings follow the vendor material (flasher_args.json):
# chip esp32c3, flash_mode dio, flash_freq 40m, flash_size 4MB.
# CDCOnBoot=cdc is required or the USB CDC serial port prints nothing.
$Fqbn = 'esp32:esp32:esp32c3:CDCOnBoot=cdc,FlashMode=dio,FlashFreq=40,FlashSize=4M' +
        ',PartitionScheme=default,UploadSpeed=921600,DebugLevel=none,EraseFlash=none'

Write-Host 'flash-and-restart: firmware upload + DSH restart' -ForegroundColor White
Write-Host "project : $RepoRoot"
Write-Host "port    : $Port"

if (-not (Test-Path $Cli))    { throw "arduino-cli not found: $Cli" }
if (-not (Test-Path $Sketch)) { throw "sketch not found: $Sketch" }

# Never let a dead proxy variable poison the toolchain.
Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:http_proxy,Env:https_proxy -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------------
# 1. Stop the DSH launcher process tree
# ---------------------------------------------------------------------------
Write-Step 'Stopping DSH (it holds the serial port)'

$launchers = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'dsh[\\/]lib[\\/]bin\.js' })

if ($launchers.Count -eq 0) {
    Write-Ok 'DSH is not running'
} else {
    foreach ($p in $launchers) {
        Write-Host "    stopping PID $($p.ProcessId)"
        # Kill the whole tree: the launcher spawns subprocess runners.
        & taskkill /PID $p.ProcessId /T /F 2>&1 | Out-Null
    }
    Start-Sleep -Seconds 2
    $still = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'dsh[\\/]lib[\\/]bin\.js' })
    if ($still.Count -eq 0) { Write-Ok 'DSH stopped' } else { Write-Warn2 "$($still.Count) launcher process(es) survived; continuing anyway" }
}

# ---------------------------------------------------------------------------
# 2. Wait for the serial port to be released
# ---------------------------------------------------------------------------
# Probe by actually trying to OPEN the port with the same serialport library the
# plugin uses. An earlier version of this script used
# `arduino-cli upload --dry-run` for the probe -- that flag does not exist, so
# the probe always "failed" and the script proceeded regardless. This probe
# reports the real answer.
Write-Step "Waiting for $Port to be released"

$PluginDir = 'C:\Users\Rrt\.dsh\plugins\dsh-led-bridge'
$probeScript = @'
const { SerialPort } = await import('serialport')
const port = process.argv[2]
try {
  const sp = new SerialPort({ path: port, baudRate: 115200, autoOpen: false })
  await new Promise((res, rej) => sp.open(err => (err ? rej(err) : res())))
  sp.close(() => {})
  console.log('FREE')
} catch (e) {
  console.log('BUSY')
}
'@

function Test-PortFree {
    param([string]$Port)
    if (-not (Test-Path (Join-Path $PluginDir 'node_modules\serialport'))) {
        # No serialport available to probe with -- assume free and let esptool decide.
        return $true
    }
    # IMPORTANT: Node resolves `import('serialport')` relative to THIS FILE, not
    # the current directory. So the probe file must live inside the plugin dir,
    # where node_modules actually is -- putting it in %TEMP% makes the import
    # fail with ERR_MODULE_NOT_FOUND and the probe would report BUSY forever.
    $probeFile = Join-Path $PluginDir 'port-probe.mjs'
    Set-Content -Path $probeFile -Value $probeScript -Encoding UTF8
    try {
        $r = & node $probeFile $Port 2>&1 | Out-String
    } finally {
        Remove-Item $probeFile -Force -ErrorAction SilentlyContinue
    }
    return ($r -match 'FREE')
}

$free = $false
for ($i = 1; $i -le 15; $i++) {
    if (Test-PortFree -Port $Port) { $free = $true; break }
    Start-Sleep -Seconds 1
}
if ($free) {
    Write-Ok "$Port is free"
} else {
    Write-Warn2 "$Port still busy after 15s -- will try to flash anyway"
}

# ---------------------------------------------------------------------------
# 3. Flash the firmware
# ---------------------------------------------------------------------------
Write-Step 'Flashing firmware'
$sw = [Diagnostics.Stopwatch]::StartNew()
$out = & $Cli --config-file $CliConfig upload --fqbn $Fqbn --port $Port $Sketch 2>&1 | Out-String
$code = $LASTEXITCODE
$sw.Stop()

if ($code -eq 0) {
    Write-Ok "uploaded in $([Math]::Round($sw.Elapsed.TotalSeconds,1))s"
} else {
    Write-Warn2 "upload FAILED (exit $code)"
    ($out -split "`n") | Where-Object { $_ -match 'error|Error|failed|Failed|busy|Hash' } |
        Select-Object -First 8 | ForEach-Object { Write-Host "      $($_.Trim())" }
    Write-Host ''
    Write-Host 'If it says the port is busy, DSH did not stop cleanly.' -ForegroundColor Yellow
    Write-Host 'If it says it could not connect, put the board in ROM download mode:' -ForegroundColor Yellow
    Write-Host '   hold BOOT, tap RST, release BOOT -- then re-run this script.'
    if (-not $NoStart) {
        Write-Host ''
        Write-Host 'Starting DSH anyway so the GUI is back up...' -ForegroundColor Yellow
    }
}

# ---------------------------------------------------------------------------
# 4. Start DSH again, detached in its own window
# ---------------------------------------------------------------------------
if (-not $NoStart) {
    Write-Step 'Starting DSH'
    # -WindowStyle Minimized keeps it out of the way; the process outlives this script.
    Start-Process -FilePath 'dsh' -ArgumentList 'web' -WindowStyle Minimized
    Start-Sleep -Seconds 6
    $up = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'dsh[\\/]lib[\\/]bin\.js' })
    if ($up.Count -gt 0) {
        Write-Ok "DSH is running again (PID $($up[0].ProcessId))"
        Write-Host '    open http://127.0.0.1:3080 if the window did not come back by itself'
    } else {
        Write-Warn2 'DSH did not come back up; start it manually with:  dsh web'
    }
}

Write-Host ''
if ($code -eq 0) {
    Write-Host 'DONE. The board should now run the new firmware.' -ForegroundColor Green
    Write-Host 'Expected behaviour when you send a message:'
    Write-Host '  yellow breathing  -> yellow + green breathing together (tools running)'
    Write-Host '  -> solid green when the turn ends'
} else {
    Write-Host 'Firmware was NOT uploaded. See the errors above.' -ForegroundColor Yellow
}
