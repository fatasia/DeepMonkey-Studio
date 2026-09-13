param(
  [string]$Target = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"
$packageRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tree = & cargo tree --manifest-path (Join-Path $packageRoot "Cargo.toml") --target $Target --edges normal --prefix none --format "{p}"
if ($LASTEXITCODE -ne 0) { throw "cargo tree failed" }

$forbidden = @("tauri", "wry", "webview", "webview2", "chromium", "electron", "cef", "web-sys", "wasm-bindgen", "js-sys", "angle", "glow", "glutin", "khronos-egl")
$packages = $tree | ForEach-Object { ($_ -split " ")[0].ToLowerInvariant() } | Sort-Object -Unique
$blocked = $packages | Where-Object {
  $name = $_
  $forbidden | Where-Object { $name -eq $_ -or $name.StartsWith("$_-") }
}
if ($blocked) { throw "Forbidden browser runtime dependencies: $($blocked -join ', ')" }

Write-Output "Native dependency policy OK: $($packages.Count) $Target runtime packages; no WebView/Chromium/browser or GL fallback bindings."
