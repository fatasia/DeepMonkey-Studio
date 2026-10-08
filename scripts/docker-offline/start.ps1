$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$manifest = Get-Content -LiteralPath './docker-images.json' -Raw | ConvertFrom-Json
$imageArchive = Join-Path $PSScriptRoot ("DeepMonkey-Studio-Docker-{0}.tar.gz" -f $manifest.version)
if (!(Test-Path -LiteralPath $imageArchive)) { throw "Place the image archive beside this script: $imageArchive" }
$stream = [System.IO.File]::OpenRead($imageArchive)
$hasher = [System.Security.Cryptography.SHA256]::Create()
try { $actual = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
finally { $stream.Dispose(); $hasher.Dispose() }
if ($actual -ne $manifest.sha256) { throw 'Docker image archive SHA-256 mismatch' }
function New-LocalSecret {
    $bytes = New-Object byte[] 24
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}
if (!(Test-Path -LiteralPath './.env')) {
    $text = Get-Content -LiteralPath './.env.example' -Raw
    foreach ($name in @('POSTGRES_PASSWORD', 'MINIO_ROOT_PASSWORD', 'BIM_STUDIO_ADMIN_PASSWORD', 'BIM_STUDIO_SESSION_SECRET')) {
        $text = $text.Replace("$name=", "$name=$(New-LocalSecret)")
    }
    [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot '.env'), $text, (New-Object System.Text.UTF8Encoding $false))
    Write-Host 'Created local .env; administrator login is admin with BIM_STUDIO_ADMIN_PASSWORD from that file.'
}
& docker load --input $imageArchive
if ($LASTEXITCODE -ne 0) { throw 'docker load failed' }
& docker compose -f docker-compose.yml -f docker-compose.app.yml up -d --no-build --pull never --wait --wait-timeout 180
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose startup failed' }
Write-Host 'DeepMonkey Studio is ready. Open STUDIO_PUBLIC_ORIGIN from .env.'
