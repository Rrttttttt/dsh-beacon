param([string]$Compiler = '', [switch]$Zig, [string]$FirmwareSource = '')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskBuild = Join-Path $taskRoot '.build\native-tests'
New-Item -ItemType Directory -Path $taskBuild -Force | Out-Null
if (-not $Compiler) {
  $taskZig = Get-ChildItem -LiteralPath (Join-Path $taskRoot '.tools\zig') -Filter zig.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($taskZig) { $Compiler = $taskZig.FullName; $Zig = $true }
  else { $Compiler = (Get-Command g++ -ErrorAction Stop).Source }
}
if (-not $FirmwareSource) { $FirmwareSource = Join-Path $taskRoot 'v2.0\firmware\esp32c3_dsh_status_light\esp32c3_dsh_status_light.ino' }
$taskSource = Get-Content -LiteralPath $FirmwareSource -Raw
$taskStart = $taskSource.IndexOf('void serviceWifiStatus(uint32_t nowMs) {')
$taskEnd = $taskSource.IndexOf('void reportBootMode()', $taskStart)
if ($taskStart -lt 0 -or $taskEnd -lt 0) { throw 'Cannot extract firmware WiFi service for regression test.' }
$taskSaveStart = $taskSource.IndexOf('void saveWifiCreds(')
$taskSaveEnd = $taskSource.IndexOf('void clearWifiCreds()', $taskSaveStart)
if ($taskSaveStart -lt 0 -or $taskSaveEnd -lt 0) { throw 'Cannot extract WiFi credential storage for regression test.' }
$taskFunctions = $taskSource.Substring($taskSaveStart, $taskSaveEnd - $taskSaveStart) + $taskSource.Substring($taskStart, $taskEnd - $taskStart)
[IO.File]::WriteAllText((Join-Path $taskBuild 'wifi_service_under_test.h'), $taskFunctions)
# Keep the optional compiler's caches inside this project.
$taskOldGlobal = $env:ZIG_GLOBAL_CACHE_DIR
$taskOldLocal = $env:ZIG_LOCAL_CACHE_DIR
try {
  $env:ZIG_GLOBAL_CACHE_DIR = Join-Path $taskBuild 'zig-global-cache'
  $env:ZIG_LOCAL_CACHE_DIR = Join-Path $taskBuild 'zig-local-cache'
  foreach ($taskTest in @('firmware_logic_test','firmware_wifi_service_test')) {
    $taskExe = Join-Path $taskBuild ($taskTest + '.exe')
    $taskArgs = @('-std=c++17','-Wall','-Wextra','-I',$taskBuild, (Join-Path $taskRoot ('tests\' + $taskTest + '.cpp')), '-o', $taskExe)
    if ($Zig) { $taskArgs = @('c++') + $taskArgs }
    & $Compiler @taskArgs
    if ($LASTEXITCODE -ne 0) { throw "Native compilation failed: $LASTEXITCODE" }
    & $taskExe
    if ($LASTEXITCODE -ne 0) { throw "Firmware logic test failed: $LASTEXITCODE" }
  }
} finally {
  $env:ZIG_GLOBAL_CACHE_DIR = $taskOldGlobal
  $env:ZIG_LOCAL_CACHE_DIR = $taskOldLocal
}
