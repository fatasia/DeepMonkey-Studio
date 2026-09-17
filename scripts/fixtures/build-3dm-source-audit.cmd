@echo off
setlocal
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" exit /b 2
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSROOT=%%i"
if not defined VSROOT exit /b 2
call "%VSROOT%\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b 1
set "ROOT=%~dp0..\.."
set "NURBS=%ROOT%\data\external-assets\industrial-format-plan\dependencies\extracted\opennurbs-v8.35.26251.13001"
set "OUT=%ROOT%\test-output\3dm-source-audit"
if not exist "%OUT%" mkdir "%OUT%"
rem 上游解决方案的必要读取目标含库依赖；不修改上游源码。
MSBuild "%NURBS%\opennurbs_public.sln" /t:Examples\example_read /p:Configuration=Release /p:Platform=x64 /p:PlatformToolset=v143 /m:4 /v:quiet /nologo
if errorlevel 1 exit /b 1
cl /nologo /std:c++17 /EHsc /O2 /MD /utf-8 /I"%NURBS%" "%~dp03dm-source-audit.cpp" /Fo"%OUT%\audit.obj" /Fe"%OUT%\3dm-source-audit.exe" /link /LTCG /Brepro /LIBPATH:"%NURBS%\bin\x64\Release" opennurbs_public_staticlib.lib zlib.lib rpcrt4.lib shlwapi.lib shell32.lib ole32.lib user32.lib gdi32.lib advapi32.lib
exit /b %errorlevel%
