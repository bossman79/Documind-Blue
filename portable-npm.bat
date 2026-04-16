@echo off
cd /d "%~dp0"
call "%~dp0scripts\prepend-portable-node.bat"
if not defined PORTABLE_NODE_DIR (
    echo ERROR: Portable Node.js not found under "%~dp0nodejs-portable\"
    exit /b 1
)
"%PORTABLE_NODE_DIR%\npm.cmd" %*
