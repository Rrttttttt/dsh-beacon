<#
.SYNOPSIS
    Install dsh-led-bridge into a DSH profile. No yaml editing required.

.DESCRIPTION
    This is the installer for the SELF-CONTAINED shape: the plugin folder next to
    this script already carries its runtime dependency tree (node_modules), so
    nothing is fetched and nothing is compiled.

    Why that matters -- measured, not guessed:

      * `dsh plugin add <spec>` forwards to pnpm with cwd = the profile directory
        and only registers the plugin when pnpm exits 0:
              const exitCode = result.status ?? 1;
              if (exitCode === 0) reconcilePlugins(before, dir);
      * A plugin that DECLARES serialport makes pnpm install it from the registry.
        @serialport/bindings-cpp has an install script; pnpm >= 10 blocks it and
        exits 1 (ERR_PNPM_IGNORED_BUILDS). The package ends up in `dependencies`
        but never in `dsh.profile.bundles` -- so DSH silently ignores it, and the
        user sees "installed, but nothing happens".
      * The usual workaround is an allowBuilds entry in the PROFILE's
        pnpm-workspace.yaml. That key cannot be set globally (pnpm refuses with
        ERR_PNPM_CONFIG_SET_UNSUPPORTED_YAML_CONFIG_KEY), so it is a manual,
        per-machine edit -- exactly what this installer exists to avoid.
      * A plugin with NO dependencies makes pnpm install exactly one package and
        exit 0, registering the plugin with no allowBuilds entry at all.

    The install uses `link:` rather than `file:` on purpose: `file:` copies only
    the package.json `files` whitelist and DROPS node_modules, while `link:`
    creates a junction that keeps the vendored tree intact.

    The plugin folder is copied to $DSH_HOME\plugins\dsh-led-bridge first when the
    path it sits in contains a space. Reason: `dsh plugin` spawns pnpm with
    shell:true on Windows, which loses argument quoting. A spec containing a space
    is split into several arguments and pnpm then tries to fetch a registry
    package named after the tail of the path, failing with
    404 ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_LATEST. DSH's own anchorPathSpec()
    does not help -- it only rewrites `.`/`..` specs. Windows 8.3 short names would
    be a clean fix but are frequently disabled on the volume.

    NOTE: This file is intentionally ASCII-only. Windows PowerShell 5.1 decodes
    .ps1 files without a BOM as the system ANSI codepage, which would garble
    non-ASCII text on Chinese Windows.

.PARAMETER Profile
    DSH profile to install into. Default: web

.PARAMETER Force
    Reinstall even if the plugin already appears in the profile's bundles.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile web -Force
#>

[CmdletBinding()]
param(
    [string]$Profile = 'web',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Write-Step { param([string]$m) Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "    [OK] $m" -ForegroundColor Green }
function Write-Warn { param([string]$m) Write-Host "    [!]  $m" -ForegroundColor Yellow }
function Die {
    param([string]$Message, [string[]]$Hints)
    Write-Host ''
    Write-Host "INSTALL FAILED: $Message" -ForegroundColor Red
    if ($Hints) {
        Write-Host ''
        Write-Host 'What to try:' -ForegroundColor Yellow
        foreach ($h in $Hints) { Write-Host "  - $h" -ForegroundColor Yellow }
    }
    exit 1
}

Write-Host 'dsh-led-bridge installer' -ForegroundColor White
Write-Host "profile: $Profile"
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'DISTRIBUTION.md')) {
    Write-Host "docs   : $(Join-Path $PSScriptRoot 'DISTRIBUTION.md')"
}

# ---------------------------------------------------------------------------
# 1. Locate the shipped plugin folder
# ---------------------------------------------------------------------------
$pluginPath = Join-Path $PSScriptRoot 'plugin'
Write-Step 'Locating the plugin folder'
if (-not (Test-Path -LiteralPath (Join-Path $pluginPath 'package.json'))) {
    Die "No plugin\package.json next to this script (looked in $pluginPath)." @(
        'Extract the whole zip, do not move install.ps1 out of its folder.'
    )
}
Write-Ok "plugin: $pluginPath"

$pkg = Get-Content -LiteralPath (Join-Path $pluginPath 'package.json') -Raw | ConvertFrom-Json
$pluginName = $pkg.name
if (-not $pluginName) { Die 'plugin\package.json has no name field.' }
Write-Ok "$pluginName v$($pkg.version)"

# ---------------------------------------------------------------------------
# 2. Sanity: the vendored dependency tree must be present and loadable
# ---------------------------------------------------------------------------
Write-Step 'Checking the bundled runtime dependency'

$nodeModules = Join-Path $pluginPath 'node_modules'
if (-not (Test-Path -LiteralPath (Join-Path $nodeModules 'serialport'))) {
    Die 'The bundle is missing plugin\node_modules\serialport.' @(
        'You are probably holding a source checkout, not the released zip.',
        'Use the zip from the GitHub Release, or install the npm tarball instead.'
    )
}
Write-Ok 'serialport is bundled'

# ---------------------------------------------------------------------------
# 3. Check the tools we need
# ---------------------------------------------------------------------------
Write-Step 'Checking required tools'

$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) {
    Die 'dsh was not found on PATH.' @(
        'Install DeepSeek Harness first:  npm i -g @deepseek-ai/dsh'
    )
}
Write-Ok "dsh  : $($dsh.Source)"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Die 'node was not found on PATH.' @('Install Node.js 20 or newer:  https://nodejs.org')
}
$nodeVersion = (& node --version) -replace '^v', ''
$nodeMajor = [int]($nodeVersion -split '\.')[0]
if ($nodeMajor -lt 20) {
    Die "Node $nodeVersion is too old (need >= 20)." @('Upgrade Node.js to 20 or newer.')
}
Write-Ok "node : $($node.Source) (v$nodeVersion)"

$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
    Die 'pnpm was not found on PATH. `dsh plugin` is a pnpm forwarder.' @(
        'Install it with:  npm i -g pnpm',
        'Or enable it with: corepack enable'
    )
}
Write-Ok "pnpm : $($pnpm.Source) ($(& pnpm --version))"

# ---------------------------------------------------------------------------
# 4. Work out $DSH_HOME and the profile directory
# ---------------------------------------------------------------------------
# DSH_HOME resolution mirrors what `dsh` itself does: DSH_HOME wins, otherwise
# ~/.dsh. Profiles live at $DSH_HOME/profiles/<name>.
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir  = Join-Path $dshHome "profiles\$Profile"
$profileJson = Join-Path $profileDir 'package.json'

# Per-profile install location, deliberately NOT a single shared folder.
#
# Why: a shared location means installing into a second profile (a test profile,
# say) SILENTLY REPLACES the plugin the first profile is using. That happened
# while testing this installer and had to be repaired by hand. Giving each
# profile its own copy makes `-Profile web` and `-Profile scratch` independent,
# and makes uninstalling one profile's plugin a plain folder delete.
$safeRoot = Join-Path $dshHome "plugins\$pluginName-$Profile"

Write-Step 'Resolving the DSH profile'
Write-Host "    DSH_HOME: $dshHome"
Write-Ok "profile dir: $profileDir"

if (Test-Path -LiteralPath $profileJson) {
    $manifest = Get-Content -LiteralPath $profileJson -Raw | ConvertFrom-Json
    $bundles = @($manifest.dsh.profile.bundles)
    if ($bundles -contains $pluginName) {
        if (-not $Force) {
            Write-Warn "$pluginName is already in this profile's bundles."
            Write-Host '    Re-run with -Force to reinstall anyway, or just restart DSH.' -ForegroundColor Yellow
            exit 0
        }
        Write-Warn "-Force given; reinstalling over the existing entry."
    }
} else {
    Write-Ok 'profile does not exist yet; dsh will initialize it'
}

# ---------------------------------------------------------------------------
# 5. Stage the plugin at its install location
# ---------------------------------------------------------------------------
Write-Step 'Staging the plugin'

if ($pluginPath -match ' ') {
    Write-Host "    source path contains a space; copying to a space-free location"
    Write-Host "    from: $pluginPath"
    Write-Host "    to  : $safeRoot"
} else {
    Write-Host "    source path is space-free, but staging anyway so every profile"
    Write-Host "    gets its own copy (a shared folder would let one profile's"
    Write-Host "    install silently replace another's)"
    Write-Host "    from: $pluginPath"
    Write-Host "    to  : $safeRoot"
}

if (Test-Path -LiteralPath $safeRoot) {
    # Delete first. If we merely merged, a previous pnpm-layout node_modules
    # would sit alongside the vendored tree and break resolution.
    Write-Host '    removing the previous install at that location...'
    Get-ChildItem -LiteralPath $safeRoot -Recurse -Force -ErrorAction SilentlyContinue |
        ForEach-Object {
            # Do not follow junctions; clear the link itself.
            if ($_.LinkType) { try { $_.Delete() } catch { } }
            else { try { $_.Attributes = 'Normal' } catch { } }
        }
    Remove-Item -LiteralPath $safeRoot -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $safeRoot) {
        Die "Could not remove the existing $safeRoot." @(
            'Close any Explorer window or editor sitting in that folder, then retry.'
        )
    }
}

New-Item -ItemType Directory -Force -Path $safeRoot | Out-Null
# /E copies subdirectories including empty ones. node_modules IS copied --
# that is the entire point of this shape.
& robocopy $pluginPath $safeRoot /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Die "robocopy failed with exit code $LASTEXITCODE" }

if (-not (Test-Path -LiteralPath (Join-Path $safeRoot 'node_modules\serialport'))) {
    Die 'The staged copy is missing node_modules\serialport.' @(
        'Antivirus software may have blocked the copy. Try again, or copy manually.'
    )
}
Write-Ok "staged at $safeRoot (including node_modules)"
$installPath = $safeRoot

# ---------------------------------------------------------------------------
# 6. Register the plugin with DSH
# ---------------------------------------------------------------------------
Write-Step "Registering the plugin into profile '$Profile'"
$spec = "link:$installPath"
Write-Host "    running: dsh plugin --profile $Profile add `"$spec`""

& dsh plugin --profile $Profile add $spec
$code = $LASTEXITCODE
if ($code -ne 0) {
    Die "dsh plugin add exited $code." @(
        'If the output above mentions ERR_PNPM_IGNORED_BUILDS, the bundle you are',
        'installing still declares serialport as a dependency. That happens with',
        'the npm tarball, not with this zip. Use the zip, or add this to',
        "$profileDir\pnpm-workspace.yaml",
        '',
        '    allowBuilds:',
        "      '@serialport/bindings-cpp': true",
        '',
        'then re-run this script.'
    )
}
Write-Ok 'plugin registered'

# ---------------------------------------------------------------------------
# 7. Verify: junction present, serialport resolves, config layer active
# ---------------------------------------------------------------------------
Write-Step 'Verifying the install'

$installedAt = Join-Path $profileDir "node_modules\$pluginName"
if (-not (Test-Path -LiteralPath $installedAt)) {
    Die "Expected an install at $installedAt but found nothing." @(
        'The profile manifest may list the plugin without a real link.'
    )
}
$linkType = (Get-Item -LiteralPath $installedAt -Force).LinkType
if ($linkType) { Write-Ok "installed as $linkType -> $installPath" }
else { Write-Ok "installed at $installedAt" }

# Resolve serialport from the installed location -- this is what the plugin does
# at runtime, so it is the most honest check available without a board attached.
$probe = @'
import('serialport').then((m) => {
  if (typeof m.SerialPort !== 'function') { process.exit(1) }
  console.log('ok')
}).catch(() => process.exit(1))
'@
Push-Location $installedAt
try {
    $probeOut = & node --input-type=module -e $probe 2>&1
    $probeCode = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($probeCode -ne 0) {
    Die 'serialport could not be loaded from the installed location.' @(
        'The vendored dependency tree did not survive the install.',
        'Re-run this script with -Force.'
    )
}
Write-Ok 'serialport resolves from the installed plugin'

# The composed config must contain our layer; without it DSH never loads us.
$dump = & dsh --profile $Profile --dump-config 2>&1 | Out-String
if ($dump -match [regex]::Escape($pluginName)) {
    Write-Ok "the $pluginName layer is active in the composed config"
} else {
    Write-Warn "Could not find $pluginName in 'dsh --profile $Profile --dump-config'."
    Write-Warn 'The install may still work; check manually with that command.'
}

# ---------------------------------------------------------------------------
# 8. Next steps
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'Installed.' -ForegroundColor Green
Write-Host ''
Write-Host 'Next:' -ForegroundColor White
Write-Host '  1) Flash the ESP32-C3 if you have not already.'
Write-Host '     The board must run the matching firmware; the lamp effects live there.'
Write-Host '     Firmware source: firmware\esp32c3_dsh_status_light\ in the repo.'
Write-Host '  2) Restart DSH so it picks up the new profile config.'
Write-Host '     Plugin config is read once at startup -- a running DSH will NOT'
Write-Host '     load a freshly added plugin until restarted.'
Write-Host '  3) Plug in the board and send a message; the light should follow state.'
Write-Host ''
Write-Host 'Troubleshooting:' -ForegroundColor White
Write-Host '  - Windows plays USB connect sounds forever, or nothing lights up:'
Write-Host '    the flash is probably empty. Flash firmware\ from the repo.'
Write-Host '  - Light never reacts at all:'
Write-Host '    confirm the plugin grabbed the port (another program may hold it).'
Write-Host '  - Light follows the wrong lamp:'
Write-Host '    this firmware expects red=GPIO5, yellow=GPIO6, green=GPIO7.'
