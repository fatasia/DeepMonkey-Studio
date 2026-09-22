param(
    [string]$ReaderRoot = 'data/external-assets/industrial-format-plan/samples/extracted/rvt-rs-main',
    [Parameter(Mandatory)][string[]]$InputFiles,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$readerPath = (Resolve-Path -LiteralPath $ReaderRoot).Path
$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $outputPath) { throw 'Use a new evidence directory; existing evidence is immutable.' }
New-Item -ItemType Directory -Path $outputPath | Out-Null
$buildPath = Join-Path $outputPath 'build'
$sourcePath = Join-Path $PSScriptRoot 'fixtures/rvt-source-identity.rs'
$manifestPath = Join-Path $readerPath 'Cargo.toml'
# 固定本地锁文件，运行与复构建均不联网；首次依赖预取由研究环境单独完成。
cargo build --offline --locked --profile ci --lib --manifest-path $manifestPath --target-dir $buildPath
if ($LASTEXITCODE -ne 0) { throw 'Offline reader build failed' }
$depsPath = Join-Path $buildPath 'ci/deps'
$externs = @()
foreach ($name in @('rvt','serde_json','sha2')) {
    $matches = @(Get-ChildItem -LiteralPath $depsPath -Filter "lib$name*.rlib")
    if ($matches.Count -ne 1) { throw "Ambiguous/missing compiled library: $name" }
    $externs += @('--extern', "$name=$($matches[0].FullName)")
}
$exePath = Join-Path $outputPath 'rvt-source-identity.exe'
$testPath = Join-Path $outputPath 'rvt-source-identity-tests.exe'
rustc --edition=2024 $sourcePath @externs -L "dependency=$depsPath" -o $exePath
if ($LASTEXITCODE -ne 0) { throw 'Audit compile failed' }
rustc --edition=2024 --test $sourcePath @externs -L "dependency=$depsPath" -o $testPath
if ($LASTEXITCODE -ne 0) { throw 'Audit test compile failed' }
& $testPath
if ($LASTEXITCODE -ne 0) { throw 'Audit tests failed' }

function Invoke-Audit([string]$inputPath, [string]$reportPath) {
    $start = [Diagnostics.ProcessStartInfo]::new($exePath)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.ArgumentList.Add($inputPath)
    $start.ArgumentList.Add($reportPath)
    $process = [Diagnostics.Process]::Start($start)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(60000)) { $process.Kill($true); throw 'RVT audit exceeded 60 seconds' }
        if ($process.ExitCode -ne 0) { throw "RVT audit failed: $($process.ExitCode): $($stderr.GetAwaiter().GetResult())" }
        Write-Output $stdout.GetAwaiter().GetResult()
    } finally {
        if (-not $process.HasExited) { $process.Kill($true) }
        $process.Dispose()
    }
}
$results = @()
foreach ($inputFile in $InputFiles) {
    $inputPath = (Resolve-Path -LiteralPath $inputFile).Path
    $before = (Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $reportPath = Join-Path $outputPath "$before.json"
    if (Test-Path -LiteralPath $reportPath) { continue } # 重复文件不增加语料分母。
    Invoke-Audit $inputPath $reportPath
    $repeatPath = Join-Path $outputPath "$before.repeat.json"
    Invoke-Audit $inputPath $repeatPath
    $after = (Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $reportHash = (Get-FileHash -LiteralPath $reportPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($before -ne $after -or $reportHash -ne (Get-FileHash -LiteralPath $repeatPath -Algorithm SHA256).Hash.ToLowerInvariant()) {
        throw 'Source changed or nondeterministic identity report'
    }
    $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    if ($report.sourceSha256 -ne $before -or $report.quality -ne 'inspect' -or $report.geometry -ne 'missing') { throw 'Invalid source/quality contract' }
    $results += [ordered]@{ sourcePath=$inputPath; sourceBytes=(Get-Item -LiteralPath $inputPath).Length; sourceSha256=$before; reportSha256=$reportHash; status=$report.status; version=$report.revitVersion; identities=$report.elements.Count }
}
$hashPaths = @($sourcePath,$PSCommandPath,$manifestPath,(Join-Path $readerPath 'Cargo.lock'),$exePath)
$hashPaths += Get-ChildItem -LiteralPath (Join-Path $readerPath 'src') -Recurse -File | Sort-Object FullName | Select-Object -ExpandProperty FullName
$hashes = foreach ($path in $hashPaths) { [ordered]@{ path=$path; sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() } }
[ordered]@{ schemaVersion=1; scope='inspect-source-identities-only'; rustc=(rustc --version); files=@($hashes); results=$results } |
    ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $outputPath 'evidence.json') -Encoding utf8
