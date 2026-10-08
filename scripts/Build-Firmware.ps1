param(
  [string]$CliPath = '',
  [string]$CoreData = '',
  [string]$BuildRoot = '',
  [ValidateSet('80','160')][string]$CpuMHz = '80',
  [switch]$MinimalConfig
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not $CliPath) {
  $taskBundled = Join-Path $taskRoot '.tools\arduino\arduino-cli.exe'
  if (Test-Path -LiteralPath $taskBundled) { $CliPath = $taskBundled }
  else { $CliPath = (Get-Command arduino-cli -ErrorAction Stop).Source }
}
if (-not $BuildRoot) { $BuildRoot = Join-Path ([IO.Path]::GetTempPath()) ('dsh-status-light-' + [Guid]::NewGuid().ToString('N')) }
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
if ($BuildRoot -match '[^\x00-\x7F]') { throw 'ESP32 Windows linker requires an ASCII build path. Set -BuildRoot to an ASCII directory.' }
New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
$taskSketch = Join-Path $taskRoot 'firmware\esp32c3_dsh_status_light'
$taskOutput = Join-Path $taskRoot $(if ($MinimalConfig) { '.build\firmware-minimal' } else { '.build\firmware' })
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
# Keep the secret out of source control and console output. Both variants reuse it.
$taskPasswordPath = Join-Path $taskRoot '.build\ap-password.txt'
if (Test-Path -LiteralPath $taskPasswordPath) {
  $taskPassword = (Get-Content -LiteralPath $taskPasswordPath -Raw).Trim()
  if ($taskPassword -notmatch '^[A-Za-z0-9]{12}$') { throw 'Invalid local AP password file.' }
} else {
  $taskAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  $taskBytes = New-Object byte[] 12
  $taskRng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $taskPassword = ''
    while ($taskPassword.Length -lt 12) {
      $taskRng.GetBytes($taskBytes)
      foreach ($taskByte in $taskBytes) {
        # Reject the incomplete last bucket to avoid modulo bias.
        if ($taskByte -lt (256 - (256 % $taskAlphabet.Length))) {
          $taskPassword += $taskAlphabet[$taskByte % $taskAlphabet.Length]
          if ($taskPassword.Length -eq 12) { break }
        }
      }
    }
  } finally { $taskRng.Dispose() }
  [IO.File]::WriteAllText($taskPasswordPath, $taskPassword + [Environment]::NewLine)
}
$taskConfigRoot = $BuildRoot + '-config'
New-Item -ItemType Directory -Path $taskConfigRoot -Force | Out-Null
$taskHeader = Join-Path $taskConfigRoot 'dsh_build_config.h'
$taskDefines = '#define DSH_CONFIG_AP_PASSWORD "' + $taskPassword + '"' + "`n"
if ($MinimalConfig) { $taskDefines += "#define DSH_MINIMAL_CONFIG_PAGE 1`n" }
[IO.File]::WriteAllText($taskHeader, $taskDefines)
$taskArgs = @()
if ($CoreData) {
  $taskDataPath = [IO.Path]::GetFullPath($CoreData).Replace('\','/')
  $taskUserPath = (Join-Path $taskRoot '.tools\arduino-user').Replace('\','/')
  $taskDownloadPath = (Join-Path $taskRoot '.tools\arduino-downloads').Replace('\','/')
  $taskConfig = Join-Path $BuildRoot 'arduino-cli.yaml'
  $taskYaml = "directories:`n  data: '$taskDataPath'`n  user: '$taskUserPath'`n  downloads: '$taskDownloadPath'`n"
  Set-Content -LiteralPath $taskConfig -Value $taskYaml -Encoding utf8
  $taskArgs += @('--config-file', $taskConfig)
}
$taskFqbn = "esp32:esp32:esp32c3:CDCOnBoot=cdc,FlashSize=4M,FlashMode=dio,FlashFreq=40,CPUFreq=$CpuMHz"
$taskInclude = '-include "' + $taskHeader.Replace('\','/') + '"'
$taskArgs += @('compile','--fqbn',$taskFqbn,'--build-path',$BuildRoot,'--output-dir',$taskOutput,'--build-property',"compiler.cpp.extra_flags=$taskInclude",$taskSketch)
& $CliPath @taskArgs
if ($LASTEXITCODE -ne 0) { throw "Arduino compile failed: $LASTEXITCODE" }
Write-Output "Firmware output: $taskOutput"
Write-Output "Config AP password file: $taskPasswordPath"
