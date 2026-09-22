param([string]$CMakePath)
$ErrorActionPreference = 'Stop'
$e57Repo = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$e57Base = Join-Path $e57Repo 'data/external-assets/industrial-format-plan'
if (-not $CMakePath) {
  $e57CMake = Get-Command cmake -ErrorAction SilentlyContinue
  if ($e57CMake) { $CMakePath = $e57CMake.Source }
  else {
    $e57Vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    $e57Vs = & $e57Vswhere -latest -products '*' -property installationPath
    if (-not $e57Vs) { throw 'Visual Studio CMake not found; specify -CMakePath' }
    $CMakePath = Join-Path $e57Vs 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
  }
}
function Invoke-E57CMake([string[]]$Arguments) {
  & $CMakePath @Arguments
  if ($LASTEXITCODE -ne 0) { throw "CMake failed: $($Arguments -join ' ')" }
}
$e57Archives = @(
  @('libE57Format-v3.4.0.tar.gz', 'e776c438d8075a538ad38a9f821c920694019cde6a2e6cc2e15bcbfb9116e54e'),
  @('xerces-c-3.3.0.tar.gz', '9555f1d06f82987fbb4658862705515740414fd34b4db6ad2ed76a2dc08d3bde')
)
foreach ($e57Archive in $e57Archives) {
  $e57File = Join-Path $e57Base "dependencies/$($e57Archive[0])"
  if ((Get-FileHash -LiteralPath $e57File -Algorithm SHA256).Hash.ToLowerInvariant() -ne $e57Archive[1]) { throw "Source SHA mismatch: $e57File" }
}
$e57XercesSource = Join-Path $e57Base 'dependencies/extracted/xerces-c-3.3.0'
$e57XercesBuild = Join-Path $e57Base 'build-trial/xerces-c-3.3.0'
$e57XercesInstall = Join-Path $e57Base 'build-trial/xerces-install'
$e57Source = Join-Path $e57Base 'dependencies/extracted/libE57Format-v3.4.0'
$e57Build = Join-Path $e57Base 'build-trial/e57-reader'
$e57CliBuild = Join-Path $e57Base 'build-trial/e57-reader-cli'
if (-not (Test-Path -LiteralPath $e57XercesSource) -or -not (Test-Path -LiteralPath $e57Source)) { throw 'Extract the verified upstream archives before building' }
Invoke-E57CMake @('-S', $e57XercesSource, '-B', $e57XercesBuild, '-G', 'Visual Studio 17 2022', '-A', 'x64', '-DBUILD_SHARED_LIBS=OFF', '-Dnetwork=OFF', '-Dtranscoder=windows', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded', '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', "-DCMAKE_INSTALL_PREFIX=$e57XercesInstall")
Invoke-E57CMake @('--build', $e57XercesBuild, '--config', 'Release', '--target', 'xerces-c', '--parallel', '2')
# Install only the library and headers, not upstream samples or generated API docs.
Invoke-E57CMake @('-DCMAKE_INSTALL_CONFIG_NAME=Release', '-DCMAKE_INSTALL_COMPONENT=runtime', '-P', "$e57XercesBuild/src/cmake_install.cmake")
Invoke-E57CMake @('-DCMAKE_INSTALL_CONFIG_NAME=Release', '-DCMAKE_INSTALL_COMPONENT=development', '-P', "$e57XercesBuild/src/cmake_install.cmake")
Invoke-E57CMake @('-S', $e57Source, '-B', $e57Build, '-G', 'Visual Studio 17 2022', '-A', 'x64', '-DE57_BUILD_TEST=OFF', '-DE57_BUILD_SHARED=OFF', '-DE57_RELEASE_LTO=OFF', '-DE57_VALIDATION_LEVEL=2', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded', "-DXercesC_INCLUDE_DIR=$e57XercesInstall/include", "-DXercesC_LIBRARY_RELEASE=$e57XercesInstall/lib/xerces-c_3.lib", '-DCMAKE_CXX_FLAGS=/DWIN32 /D_WINDOWS /EHsc /DXERCES_STATIC_LIBRARY')
Invoke-E57CMake @('--build', $e57Build, '--config', 'Release', '--parallel', '2')
Invoke-E57CMake @('-S', $PSScriptRoot, '-B', $e57CliBuild, '-G', 'Visual Studio 17 2022', '-A', 'x64', "-DE57_SOURCE=$e57Source", "-DE57_BUILD=$e57Build", "-DXERCES_INSTALL=$e57XercesInstall")
Invoke-E57CMake @('--build', $e57CliBuild, '--config', 'Release', '--parallel', '2')
