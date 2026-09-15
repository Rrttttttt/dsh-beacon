<#
.SYNOPSIS
    Build the distributable artifacts for dsh-led-bridge.

.DESCRIPTION
    Produces two install shapes from one source tree:

      A. dist/dsh-led-bridge/          self-contained folder  -> `link:` install,
                                       ZERO configuration on the target machine
         dist/dsh-led-bridge-<v>.zip  the same folder, zipped (what you hand out)

      B. dist/dsh-led-bridge-<v>.tgz   dependency-free npm tarball -> publish to npm
                                       or attach to a GitHub Release

    Why two shapes exist (all of this was measured, not assumed):

      * `pnpm pack` / `npm pack` ALWAYS exclude node_modules -- putting it in
        package.json's `files` does not help. So a tarball can never carry the
        prebuilt serialport binding.
      * `dsh plugin add <tarball>` therefore has to install serialport from the
        registry. @serialport/bindings-cpp declares an install script, pnpm >= 10
        blocks it and exits 1 (ERR_PNPM_IGNORED_BUILDS), and `dsh plugin` only
        registers the plugin when pnpm exits 0:
            const exitCode = result.status ?? 1;
            if (exitCode === 0) reconcilePlugins(before, dir);
        Net effect: the package lands in `dependencies` but NEVER enters
        `dsh.profile.bundles`, so DSH silently does not load it.
      * The only fix is `allowBuilds: {'@serialport/bindings-cpp': true}` in the
        PROFILE's pnpm-workspace.yaml. That key cannot be set globally
        (pnpm rejects it with ERR_PNPM_CONFIG_SET_UNSUPPORTED_YAML_CONFIG_KEY).
      * Shape A sidesteps all of it: the plugin declares NO dependencies, so pnpm
        installs exactly one package, exits 0, and registers the plugin with no
        allowBuilds entry at all. `link:` keeps the vendored node_modules because
        it creates a junction instead of copying files. (`file:` does NOT --
        it copies only the `files` whitelist and drops node_modules.)

    The vendored tree is installed with npm (flat layout) rather than pnpm,
    because pnpm's symlink farm is fragile to copy and archive.

    Build-time deps are stripped from the vendored @serialport/bindings-cpp:
    its `gypfile: true` + `scripts.install` would otherwise make pnpm attempt a
    build if it ever re-resolves that package. Runtime behaviour is unchanged --
    node-gyp-build already resolves the shipped prebuilt .node binaries.

    NOTE: This file is intentionally ASCII-only. Windows PowerShell 5.1 decodes
    .ps1 files without a BOM as the system ANSI codepage, which would garble
    non-ASCII text on Chinese Windows.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\pack.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\pack.ps1 -SkipInstall
    # reuse a previously installed vendored tree (faster iteration)
#>

[CmdletBinding()]
param(
    # Reuse dist/.../plugin/node_modules instead of reinstalling.
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

function Write-Step { param([string]$m) Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "    [OK] $m" -ForegroundColor Green }
function Write-Warn { param([string]$m) Write-Host "    [!]  $m" -ForegroundColor Yellow }
function Write-Fail { param([string]$m) Write-Host "    [X]  $m" -ForegroundColor Red }

$repoRoot   = Split-Path -Parent $PSScriptRoot
$pluginSrc  = Join-Path $repoRoot 'plugin'
$distRoot   = Join-Path $repoRoot 'dist'
$pkgDir     = Join-Path $distRoot 'dsh-led-bridge'
$vendorDir  = Join-Path $pkgDir 'plugin'

Write-Host 'dsh-led-bridge packer' -ForegroundColor White
Write-Host "repo   : $repoRoot"
Write-Host "output : $distRoot"

# ---------------------------------------------------------------------------
# 0. Sanity: source tree must be intact
# ---------------------------------------------------------------------------
Write-Step 'Checking source tree'

foreach ($f in @('package.json', 'lib\index.js', 'cordis.patch.yml', 'README.md', 'LICENSE')) {
    if (-not (Test-Path -LiteralPath (Join-Path $pluginSrc $f))) {
        throw "Missing plugin\$f -- run this from the repo's scripts\ folder."
    }
}
Write-Ok 'plugin source is complete'

$pkg = Get-Content -LiteralPath (Join-Path $pluginSrc 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
if (-not $version) { throw 'package.json has no version field.' }
Write-Ok "version $version"

# The tarball name pnpm will produce.
$tgzName = "$($pkg.name)-$version.tgz"

# ---------------------------------------------------------------------------
# 1. Clean and rebuild dist/
# ---------------------------------------------------------------------------
Write-Step 'Rebuilding dist/'
if (Test-Path -LiteralPath $distRoot) {
    # node_modules may contain read-only bits; clear attributes first so the
    # recursive delete cannot stall.
    Get-ChildItem -LiteralPath $distRoot -Recurse -Force -ErrorAction SilentlyContinue |
        ForEach-Object { try { $_.Attributes = 'Normal' } catch { } }
    Remove-Item -LiteralPath $distRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $vendorDir | Out-Null
Write-Ok 'dist/ recreated'

# ---------------------------------------------------------------------------
# 2. Copy plugin SOURCE (no node_modules, no pnpm leftovers)
# ---------------------------------------------------------------------------
Write-Step 'Copying plugin source'
& robocopy $pluginSrc $vendorDir /E /XD node_modules /XF pnpm-lock.yaml pnpm-workspace.yaml /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
Write-Ok "source copied to $vendorDir"

# pnpm leftovers must not survive: pnpm-workspace.yaml would turn this folder
# into a workspace root and break `pnpm pack`, and it carries a machine-local
# allowBuilds decision that has no business being redistributed.
foreach ($junk in @('pnpm-lock.yaml', 'pnpm-workspace.yaml')) {
    $p = Join-Path $vendorDir $junk
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force; Write-Ok "removed leftover $junk" }
}

# ---------------------------------------------------------------------------
# 3. Install the vendored runtime dependency tree (shape A's whole point)
# ---------------------------------------------------------------------------
Write-Step 'Installing vendored runtime dependencies (npm, flat layout)'

$nodeModules = Join-Path $vendorDir 'node_modules'
if ($SkipInstall) {
    if (-not (Test-Path -LiteralPath $nodeModules)) {
        throw '-SkipInstall was given but dist\...\plugin\node_modules does not exist.'
    }
    Write-Warn 'reusing existing vendored node_modules'
} else {
    # npm walks UP the directory tree looking for an existing node_modules and
    # will happily decide it is "up to date" against a parent project's manifest.
    # dist\...\plugin sits under the repo, so that is exactly what happens. Do the
    # install in an isolated staging folder that has no ancestor node_modules,
    # then move the result into place.
    $stage = Join-Path $distRoot '_deps-stage'
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null

    # The authoritative dependency list is the plugin's own manifest. A second
    # hardcoded copy here would silently drift out of date, so read it from the
    # source package.json and temporarily drop the `dsh` block: otherwise npm may
    # try to resolve the bundle's own patch reference.
    $srcManifest = Get-Content -LiteralPath (Join-Path $pluginSrc 'package.json') -Raw | ConvertFrom-Json
    if (-not $srcManifest.dependencies) {
        throw 'plugin\package.json declares no dependencies, but the self-contained shape needs the serialport tree. Re-add "serialport" to dependencies (the packer strips it from the shipped copy afterwards).'
    }
    $depNames = @($srcManifest.dependencies.PSObject.Properties.Name)
    Write-Host "    dependencies to vendor: $($depNames -join ', ')"

    $srcManifest.PSObject.Properties.Remove('dsh')
    # Serialize with write-json.ps1, NOT ConvertTo-Json: the latter is not
    # byte-stable across PowerShell versions (PS 5.1 uses 4-space indent and
    # escapes ">" as \u003e; PS 7 uses 2-space indent), which would make the
    # published artifact's SHA256 unreproducible between a local run and CI.
    $stageManifest = Join-Path $stage 'package.json'
    [System.IO.File]::WriteAllText(
        $stageManifest,
        ($srcManifest | ConvertTo-Json -Depth 30),
        (New-Object System.Text.UTF8Encoding($false))
    )
    & (Join-Path $PSScriptRoot 'write-json.ps1') -Path $stageManifest
    if ($LASTEXITCODE -ne 0) { throw "write-json.ps1 failed on $stageManifest" }

    Push-Location $stage
    try {
        # --omit=dev        : devDependencies must not ship
        # --no-package-lock : no lockfile inside the artifact
        & npm install --omit=dev --no-package-lock --no-audit --no-fund --loglevel=error
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }

    if (-not (Test-Path -LiteralPath (Join-Path $stage 'node_modules'))) {
        throw 'npm install produced no node_modules in the staging folder.'
    }

    & robocopy (Join-Path $stage 'node_modules') $nodeModules /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok 'dependencies installed'
}

if (-not (Test-Path -LiteralPath (Join-Path $nodeModules 'serialport'))) {
    throw 'serialport was not installed into the vendored tree.'
}

# Package-lock artifacts npm may leave behind should not ship.
foreach ($junk in @('.package-lock.json')) {
    $p = Join-Path $nodeModules $junk
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force; Write-Ok "removed node_modules\$junk" }
}

# ---------------------------------------------------------------------------
# 4. Strip `dependencies` from the SHIPPED manifest
# ---------------------------------------------------------------------------
# This is what makes the target machine need no allowBuilds entry: pnpm sees a
# package with no dependencies, installs exactly one package, exits 0, and
# registers the plugin. The tree it needs is already sitting in node_modules.
# The SOURCE manifest keeps the declaration (the npm tarball needs it); only the
# self-contained copy drops it.
Write-Step 'Stripping dependencies from the shipped manifest'

$vendorPkgPath = Join-Path $vendorDir 'package.json'
$vp = Get-Content -LiteralPath $vendorPkgPath -Raw | ConvertFrom-Json
if ($vp.PSObject.Properties.Name -contains 'dependencies') {
    $dropped = @($vp.dependencies.PSObject.Properties.Name)
    $vp.PSObject.Properties.Remove('dependencies')
    [System.IO.File]::WriteAllText($vendorPkgPath, ($vp | ConvertTo-Json -Depth 30), (New-Object System.Text.UTF8Encoding($false)))
    # Fixed serializer again: ConvertTo-Json alone is version-dependent, which
    # would make the zip's bytes (and SHA256) differ between local and CI.
    & (Join-Path $PSScriptRoot 'write-json.ps1') -Path $vendorPkgPath
    if ($LASTEXITCODE -ne 0) { throw "write-json.ps1 failed on $vendorPkgPath" }
    Write-Ok "shipped manifest no longer declares: $($dropped -join ', ')"
} else {
    Write-Ok 'shipped manifest already has no dependencies'
}

# ---------------------------------------------------------------------------
# 5. Strip build markers from the vendored native binding
# ---------------------------------------------------------------------------
# @serialport/bindings-cpp ships `gypfile: true` plus `scripts.install`, which is
# exactly what pnpm's build-script guard keys on. The prebuilt .node binaries are
# already inside the package, so removing these only prevents pnpm from wanting
# to build -- runtime behaviour is identical.
Write-Step 'Stripping build markers from vendored bindings-cpp'

$bcPkgPath = Join-Path $nodeModules '@serialport\bindings-cpp\package.json'
if (Test-Path -LiteralPath $bcPkgPath) {
    $bc = Get-Content -LiteralPath $bcPkgPath -Raw | ConvertFrom-Json
    $hadGypfile = $null -ne $bc.gypfile
    $hadScripts = $null -ne $bc.scripts
    foreach ($k in @('gypfile', 'scripts', 'devDependencies', 'cc')) {
        if ($bc.PSObject.Properties.Name -contains $k) { $bc.PSObject.Properties.Remove($k) }
    }
    $json = $bc | ConvertTo-Json -Depth 30
    [System.IO.File]::WriteAllText($bcPkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    # Fixed serializer: this file lands in the zip, so its bytes must be identical
    # on every machine or the artifact's SHA256 cannot be reproduced.
    & (Join-Path $PSScriptRoot 'write-json.ps1') -Path $bcPkgPath
    if ($LASTEXITCODE -ne 0) { throw "write-json.ps1 failed on $bcPkgPath" }
    Write-Ok "stripped (gypfile present: $hadGypfile, scripts present: $hadScripts)"
} else {
    Write-Warn 'bindings-cpp not found; skipped (serialport may have changed layout)'
}

# ---------------------------------------------------------------------------
# 6. Verify the vendored tree actually loads
# ---------------------------------------------------------------------------
Write-Step 'Verifying the vendored tree resolves serialport'

$probe = @'
import('serialport').then((m) => {
  if (typeof m.SerialPort !== 'function') { console.log('MISSING SerialPort'); process.exit(1) }
  if (typeof m.ReadlineParser !== 'function') { console.log('MISSING ReadlineParser'); process.exit(1) }
  console.log('serialport OK');
}).catch((e) => { console.log('LOAD FAILED: ' + e.message); process.exit(1) })
'@

Push-Location $vendorDir
try {
    $out = & node --input-type=module -e $probe 2>&1
    if ($LASTEXITCODE -ne 0) { throw "vendored serialport failed to load: $out" }
} finally {
    Pop-Location
}
Write-Ok ($out | Out-String).Trim()

# Confirm the platform binding we care about is present.
$nativeCount = (Get-ChildItem -LiteralPath $nodeModules -Recurse -Filter '*.node' -ErrorAction SilentlyContinue | Measure-Object).Count
if ($nativeCount -eq 0) { throw 'No prebuilt .node binaries found in the vendored tree.' }
Write-Ok "$nativeCount prebuilt platform bindings present"

# Run the real plugin logic offline, to be sure packing did not break anything.
Write-Step 'Smoke-testing the real plugin API from the vendored copy'
$smoke = @'
import('./lib/index.js').then((m) => {
  const sent = []
  const listeners = []
  const ctx = { logger: { info() {} }, on(ev, h) { listeners.push(ev); return () => {} } }
  const dispose = m.apply(ctx, { port: 'COM_NOT_REAL', reconnectIntervalMs: 999999 })
  if (listeners.length !== 1) { console.log('BAD listener count'); process.exit(1) }
  dispose()
  console.log('apply()/dispose() OK; subscribed=' + listeners.join(','))
}).catch((e) => { console.log('SMOKE FAILED: ' + e.message); process.exit(1) })
'@
Push-Location $vendorDir
try {
    $smokeOut = & node --input-type=module -e $smoke 2>&1
    if ($LASTEXITCODE -ne 0) { throw "plugin smoke test failed: $smokeOut" }
} finally {
    Pop-Location
}
Write-Ok ($smokeOut | Out-String).Trim()

# ---------------------------------------------------------------------------
# 7. Lay out shape A: the self-contained folder
# ---------------------------------------------------------------------------
Write-Step 'Assembling the self-contained folder'

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-dist.ps1') -Destination (Join-Path $pkgDir 'install.ps1') -Force
Write-Ok 'install.ps1'

# Ship the distribution notes inside the folder too, so someone who only has the
# extracted zip still has the explanation next to the installer.
$howto = Join-Path $repoRoot 'docs\DISTRIBUTION.md'
if (Test-Path -LiteralPath $howto) {
    Copy-Item -LiteralPath $howto -Destination (Join-Path $pkgDir 'DISTRIBUTION.md') -Force
    Write-Ok 'DISTRIBUTION.md'
} else {
    Write-Warn 'docs\DISTRIBUTION.md not found; the folder will ship without it'
}

Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination (Join-Path $pkgDir 'LICENSE') -Force
Write-Ok 'LICENSE'

# ---------------------------------------------------------------------------
# 8. Shape B: the tarball
# ---------------------------------------------------------------------------
Write-Step "Building the tarball ($tgzName)"

# The two shapes are OPPOSITE on purpose, and getting this backwards ships a
# broken package. This was a real bug in v0.2.0:
#
#   Shape A (folder/zip) -- NO dependencies declared. The vendored node_modules
#     next to it IS the dependency. Declaring them would make pnpm try to fetch
#     and build, which is exactly the allowBuilds trap we are avoiding.
#
#   Shape B (tarball) -- dependencies DECLARED. `pnpm pack` always excludes
#     node_modules, so the tarball has no vendored tree; the only way it can get
#     serialport is to declare it. If a tarball declares nothing AND carries
#     nothing, `dsh plugin add` succeeds but the plugin then fails to import
#     serialport at runtime -- it degrades to "serialport not installed, serial
#     unavailable" and the lamp never moves. The install LOOKS fine, which is
#     what makes it dangerous.
#
# So the tarball is packed from its own staging copy, built from the SOURCE
# manifest (which still declares serialport) rather than from the stripped
# vendored copy.
$tarballSrc = Join-Path $distRoot '_tarball-src'
if (Test-Path -LiteralPath $tarballSrc) { Remove-Item -LiteralPath $tarballSrc -Recurse -Force }
New-Item -ItemType Directory -Force -Path $tarballSrc | Out-Null

# Copy the source files (lib, cordis.patch.yml, README, LICENSE) but never
# node_modules -- and never the stripped manifest.
foreach ($item in @('lib', 'cordis.patch.yml', 'README.md', 'LICENSE')) {
    $from = Join-Path $pluginSrc $item
    if (Test-Path -LiteralPath $from) {
        Copy-Item -LiteralPath $from -Destination $tarballSrc -Recurse -Force
    }
}
# The manifest must be the SOURCE one, which declares serialport.
Copy-Item -LiteralPath (Join-Path $pluginSrc 'package.json') -Destination (Join-Path $tarballSrc 'package.json') -Force

$tPkg = Get-Content -LiteralPath (Join-Path $tarballSrc 'package.json') -Raw | ConvertFrom-Json
if (-not $tPkg.dependencies -or -not $tPkg.dependencies.serialport) {
    throw 'The tarball staging manifest has no serialport dependency. A tarball without it cannot work.'
}
Write-Ok "tarball declares dependencies: $((@($tPkg.dependencies.PSObject.Properties.Name)) -join ', ')"

# Norm and then pack with scripts/_targz.mjs, NOT `pnpm pack`.
#
# Why: `pnpm pack`'s output bytes depend on things outside our control (the gzip
# header's OS byte, pnpm/npm version, and more). Local runs were stable, but CI
# produced a DIFFERENT tgz from the same commit (20837 vs 20226 bytes) -- and I
# could not reproduce CI's bytes locally, which means the artifact could not be
# verified by anyone. If it has to be reproducible, we pin every byte ourselves.
& (Join-Path $PSScriptRoot 'write-json.ps1') -Path (Join-Path $tarballSrc 'package.json')
if ($LASTEXITCODE -ne 0) { throw 'write-json.ps1 failed on the tarball manifest' }

$producedTgz = Join-Path $distRoot $tgzName
if (Test-Path -LiteralPath $producedTgz) { Remove-Item -LiteralPath $producedTgz -Force }
& node (Join-Path $PSScriptRoot '_targz.mjs') $tarballSrc $producedTgz
if ($LASTEXITCODE -ne 0) { throw "_targz.mjs failed with exit code $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath $producedTgz)) { throw "tarball was not produced at $producedTgz" }
Write-Ok "tarball: $tgzName"

# Staging is an implementation detail; keep dist/ clean.
Remove-Item -LiteralPath $tarballSrc -Recurse -Force -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------------
# 9. Shape A (continued): the zip
# ---------------------------------------------------------------------------
Write-Step 'Zipping the self-contained folder'

$zipName = "$($pkg.name)-$version.zip"
$zipPath = Join-Path $distRoot $zipName
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

# Stage the folder under its OWN name first, so the zip's top level is
# "dsh-led-bridge/..." -- extracting anywhere then yields a folder whose
# install.ps1 can be run directly.
#
# Why not Compress-Archive: it writes DIFFERENT BYTES on PS 5.1 vs PS 7, so the
# zip produced by `powershell -File scripts/pack.ps1` (what README tells users to
# run) would not match the one CI builds from the same commit -- and anyone
# verifying a download against SHA256SUMS.txt would think it was tampered with.
# scripts/_zip.mjs pins timestamps, entry order, permissions and compression.
$zipStage = Join-Path $distRoot '_zip-stage'
if (Test-Path -LiteralPath $zipStage) { Remove-Item -LiteralPath $zipStage -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $zipStage $pkg.name) | Out-Null
& robocopy $pkgDir (Join-Path $zipStage $pkg.name) /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE while staging the zip" }

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw 'node not found on PATH. The packer needs it for byte-stable zip output.' }
& node (Join-Path $PSScriptRoot '_zip.mjs') $zipStage $zipPath
if ($LASTEXITCODE -ne 0) { throw "_zip.mjs failed with exit code $LASTEXITCODE" }
Remove-Item -LiteralPath $zipStage -Recurse -Force -ErrorAction SilentlyContinue

if (-not (Test-Path -LiteralPath $zipPath)) { throw "zip was not produced at $zipPath" }
Write-Ok "zip: $zipName"

# ---------------------------------------------------------------------------
# 10. Checksums + summary
# ---------------------------------------------------------------------------
Write-Step 'Writing SHA256SUMS.txt'

$sums = @()
foreach ($art in @($zipPath, $producedTgz)) {
    if (Test-Path -LiteralPath $art) {
        $h = (Get-FileHash -LiteralPath $art -Algorithm SHA256).Hash
        $sums += ("{0}  {1}" -f $h, (Split-Path -Leaf $art))
    }
}
$sumsFile = Join-Path $distRoot 'SHA256SUMS.txt'
[System.IO.File]::WriteAllLines($sumsFile, $sums, (New-Object System.Text.UTF8Encoding($false)))
foreach ($s in $sums) { Write-Ok $s }

Write-Host ''
Write-Host 'Artifacts:' -ForegroundColor White
Get-ChildItem -LiteralPath $distRoot | ForEach-Object {
    $size = if ($_.PSIsContainer) { '<dir>' } else { '{0:N0} bytes' -f $_.Length }
    Write-Host ("  {0,-12} {1}" -f $size, $_.Name)
}

$vendorSize = (Get-ChildItem -LiteralPath $nodeModules -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
Write-Host ''
Write-Host ("Vendored dependency tree: {0:N2} MB" -f ($vendorSize / 1MB)) -ForegroundColor White

Write-Host ''
Write-Host 'Next:' -ForegroundColor White
Write-Host "  verify the artifacts : node scripts\verify-dist.mjs"
Write-Host "  publish to npm       : cd plugin; npm publish --access public"
Write-Host "  attach to a Release  : upload dist\$zipName and dist\$tgzName"
