param(
    [Parameter(Mandatory)][string]$ParserRoot,
    [Parameter(Mandatory)][string]$CorpusRoot,
    [string]$OutputDirectory = 'test-output/xt-research-audit'
)
$ErrorActionPreference = 'Stop'
$parserPath = (Resolve-Path -LiteralPath $ParserRoot).Path
$corpusPath = (Resolve-Path -LiteralPath $CorpusRoot).Path
$sourcePath = Join-Path $PSScriptRoot 'fixtures/xt-parser-audit.rs'
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null

# Use the inspected local source and lockfile; runtime evaluation makes no network requests.
cargo build --offline --locked --release --lib --manifest-path (Join-Path $parserPath 'Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw 'Local parser build failed' }
$metadataText = cargo metadata --offline --locked --no-deps --format-version 1 --manifest-path (Join-Path $parserPath 'Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve parser build artifacts' }
$metadata = $metadataText | ConvertFrom-Json
$releasePath = Join-Path $metadata.target_directory 'release'
$libraryPath = Join-Path $releasePath 'libxt_parser.rlib'
$depsPath = Join-Path $releasePath 'deps'
$executablePath = Join-Path $outputPath 'xt-parser-audit.exe'
$testPath = Join-Path $outputPath 'xt-parser-audit-tests.exe'
rustc --edition=2024 $sourcePath --extern "xt_parser=$libraryPath" -L "dependency=$depsPath" -o $executablePath
if ($LASTEXITCODE -ne 0) { throw 'Audit compilation failed' }
rustc --edition=2024 --test $sourcePath --extern "xt_parser=$libraryPath" -L "dependency=$depsPath" -o $testPath
if ($LASTEXITCODE -ne 0) { throw 'Audit test compilation failed' }
& $testPath
if ($LASTEXITCODE -ne 0) { throw 'Audit regression failed' }

$reportPath = Join-Path $outputPath 'report.tsv'
& $executablePath $corpusPath | Tee-Object -FilePath $reportPath
if ($LASTEXITCODE -ne 0) { throw 'Corpus enumeration or audit failed' }
$hashPaths = @($sourcePath, $libraryPath, $executablePath, $reportPath,
    (Join-Path $parserPath 'Cargo.toml'), (Join-Path $parserPath 'Cargo.lock'))
$hashPaths += Get-ChildItem -LiteralPath (Join-Path $parserPath 'src') -Recurse -File -Filter '*.rs' |
    Sort-Object FullName | Select-Object -ExpandProperty FullName
$hashes = foreach ($hashPath in $hashPaths) {
    $hash = Get-FileHash -LiteralPath $hashPath -Algorithm SHA256
    [ordered]@{ path = $hash.Path; sha256 = $hash.Hash.ToLowerInvariant() }
}
[ordered]@{
    schemaVersion = 1
    scope = 'research-parser-structural-audit-only'
    rustc = (rustc --version)
    parserRoot = $parserPath
    corpusRoot = $corpusPath
    files = @($hashes)
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outputPath 'evidence.json') -Encoding utf8
