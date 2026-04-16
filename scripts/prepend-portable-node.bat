@echo off
REM Prepends repo portable Node to PATH and sets PORTABLE_NODE_DIR (folder containing node.exe).
set "PORTABLE_NODE_DIR="
if not exist "%~dp0..\nodejs-portable\" exit /b 0
for /d %%D in ("%~dp0..\nodejs-portable\*") do (
  if exist "%%D\node.exe" set "PORTABLE_NODE_DIR=%%D"
)
if defined PORTABLE_NODE_DIR set "PATH=%PORTABLE_NODE_DIR%;%PATH%"
exit /b 0
