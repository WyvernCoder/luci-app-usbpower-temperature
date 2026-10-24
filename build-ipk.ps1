[CmdletBinding()]
param(
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'

$builder = Join-Path $PSScriptRoot 'tools/build_ipk.py'
if (-not (Test-Path -LiteralPath $builder)) {
    Write-Error "Missing builder: $builder"
    exit 1
}

& $Python $builder
exit $LASTEXITCODE
