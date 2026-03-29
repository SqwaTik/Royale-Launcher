@echo off
setlocal

set "ROOT=%~dp0"
set "GAME_DIR=%ROOT%"

set "LAUNCHER_A=%ProgramFiles(x86)%\Minecraft Launcher\MinecraftLauncher.exe"
set "LAUNCHER_B=%ProgramFiles%\Minecraft Launcher\MinecraftLauncher.exe"
set "LAUNCHER_C=%LocalAppData%\Programs\Minecraft Launcher\MinecraftLauncher.exe"
set "LAUNCHER_D=%LocalAppData%\Microsoft\WindowsApps\MinecraftLauncher.exe"

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

if exist "%LAUNCHER_D%" (
  start "" "%LAUNCHER_D%"
  exit /b 0
)

start "" explorer.exe "%GAME_DIR%"
exit /b 0
