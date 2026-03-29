@echo off
setlocal

set "ROOT=%~dp0"
set "MODS_DIR=%APPDATA%\.minecraft\mods"
set "MOD_NAME=royale-1.0.06.jar"

if not exist "%MODS_DIR%" (
  mkdir "%MODS_DIR%"
)

del /Q "%MODS_DIR%\royale-*.jar" 2>nul
copy /Y "%ROOT%mods\%MOD_NAME%" "%MODS_DIR%\%MOD_NAME%" >nul

set "LAUNCHER_A=%ProgramFiles(x86)%\Minecraft Launcher\MinecraftLauncher.exe"
set "LAUNCHER_B=%ProgramFiles%\Minecraft Launcher\MinecraftLauncher.exe"
set "LAUNCHER_C=%LocalAppData%\Programs\Minecraft Launcher\MinecraftLauncher.exe"

if exist "%LAUNCHER_A%" (
  start "" "%LAUNCHER_A%"
  exit /b 0
)

if exist "%LAUNCHER_B%" (
  start "" "%LAUNCHER_B%"
  exit /b 0
)

if exist "%LAUNCHER_C%" (
  start "" "%LAUNCHER_C%"
  exit /b 0
)

start "" explorer.exe "%MODS_DIR%"
exit /b 0
