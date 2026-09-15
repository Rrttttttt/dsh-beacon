<#
.SYNOPSIS
    Serialize one or more JSON files with a FIXED byte representation.

.DESCRIPTION
    `ConvertTo-Json` is NOT byte-stable across PowerShell versions. Measured on
    this machine, same object:

        PS 5.1  ->  4-space indent,  "key":  "value" (TWO spaces after colon),
                   and escapes ">" as \u003e
        PS 7.6  ->  2-space indent,  "key": "value",  ">" kept literal

    So `powershell -File scripts/pack.ps1` (what README tells users to run) and
    the CI job's `shell: pwsh` produced DIFFERENT BYTES for the same commit. The
    content is equivalent (both parse to the same object), but the published
    artifact's SHA256 could not be reproduced locally -- someone verifying a
    download would conclude the package had been tampered with.

    This script delegates to Node's `JSON.stringify(value, null, 2)`, which is
    stable everywhere, so the packer emits identical bytes on any machine.

    Usage (one file):
        pwsh -File write-json.mjs-fixed.ps1 -Path <in.json> [-Out <out.json>]

    Usage (several files, one call -- avoids paying Node startup per file):
        pwsh -File write-json.mjs-fixed.ps1 -Path <a.json> -Path <b.json> ...

    With -Out and exactly one -Path, writes there. Otherwise rewrites each -Path
    in place.

    Implementation note: Node's own JSON.stringify already writes 2-space
    indentation, so the JS side is deliberately tiny. The wrapper exists only to
    reach a JS runtime from PowerShell.

.NOTES
    This file is intentionally ASCII-only (Windows PowerShell 5.1 decodes .ps1
    files without a BOM using the system ANSI codepage).
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string[]]$Path,
    [string]$Out = ''
)

$ErrorActionPreference = 'Stop'

# The JS program is passed via a temp file rather than -e so that quoting can
# never mangle it on the way through cmd/PowerShell.
$js = @'
const fs = require('node:fs')
const args = process.argv.slice(2)
const sep = args.indexOf('--sep')
const inputs = args.slice(0, sep)
const output = args[sep + 1]

inputs.forEach((input, i) => {
  const value = JSON.parse(fs.readFileSync(input, 'utf8'))
  const text = JSON.stringify(value, null, 2) + '\n'
  const target = inputs.length === 1 && output ? output : input
  fs.writeFileSync(target, text, 'utf8')
})
'@

$tmpJs = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-json-" + [guid]::NewGuid().ToString('N') + ".js")
try {
    [System.IO.File]::WriteAllText($tmpJs, $js, (New-Object System.Text.UTF8Encoding($false)))

    $node = (Get-Command node -ErrorAction SilentlyContinue)
    if (-not $node) {
        throw 'node not found on PATH. The packer needs it for byte-stable JSON output.'
    }

    $argv = @($tmpJs) + $Path + @('--sep', $Out)
    $nodeOut = & node @argv 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "node failed while rewriting JSON: $nodeOut"
    }

    foreach ($p in $Path) {
        if (-not (Test-Path -LiteralPath $p)) { throw "JSON file missing after rewrite: $p" }
    }
} finally {
    Remove-Item -LiteralPath $tmpJs -Force -ErrorAction SilentlyContinue
}
