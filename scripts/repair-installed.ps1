$ErrorActionPreference = 'Stop'
$sourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\release\win-unpacked\resources\runtime'))
$targetRoot = 'C:\Program Files\Vibe Studio\resources\runtime'
if (-not (Test-Path -LiteralPath (Join-Path $targetRoot 'desktop-host.mjs'))) { throw 'Installed backend not found.' }
# This repair only adds the missing runtime dependencies to the known 0.1.0
# installation. Refuse to repair a different backend or Node ABI.
foreach ($name in @('desktop-host.mjs','node.exe')) {
    $sourceHash = (Get-FileHash -LiteralPath (Join-Path $sourceRoot $name) -Algorithm SHA256).Hash
    $targetHash = (Get-FileHash -LiteralPath (Join-Path $targetRoot $name) -Algorithm SHA256).Hash
    if ($sourceHash -ne $targetHash) { throw "Installed $name does not match the verified runtime. Use the 0.1.1 installer." }
}
$manifestFile = Join-Path $sourceRoot 'dependencies-manifest.json'
$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
$copied = 0
foreach ($entry in $manifest.PSObject.Properties) {
    $sourceFile = Join-Path (Join-Path $sourceRoot 'node_modules') $entry.Name
    $targetFile = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $targetRoot 'node_modules') $entry.Name))
    if (-not $targetFile.StartsWith($targetRoot + '\node_modules\',[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid dependency path.' }
    if ((Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value) { throw 'Source dependency checksum mismatch.' }
    if (Test-Path -LiteralPath $targetFile) {
        if ((Get-FileHash -LiteralPath $targetFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value) { throw "Refusing to overwrite existing dependency: $targetFile" }
        continue
    }
    New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($targetFile)) -Force | Out-Null
    Copy-Item -LiteralPath $sourceFile -Destination $targetFile
    if ((Get-FileHash -LiteralPath $targetFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value) { throw 'Installed dependency checksum mismatch.' }
    $copied++
}
Copy-Item -LiteralPath $manifestFile -Destination (Join-Path $targetRoot 'dependencies-manifest.json')
Write-Output "Installed runtime repaired: $copied dependency files added."
