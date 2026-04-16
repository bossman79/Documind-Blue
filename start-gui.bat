@echo off
title Documind GUI
cd /d "%~dp0"
set "DOCUMIND_PROJECT_ROOT=%~dp0"

REM --- Portable Node.js only (see nodejs-portable\) ---
call "%~dp0scripts\prepend-portable-node.bat"
if not defined PORTABLE_NODE_DIR (
    echo ERROR: Portable Node.js not found.
    echo Unpack a Windows x64 Node build under: "%~dp0nodejs-portable\" ^(folder must contain node.exe^).
    pause
    exit /b 1
)
echo Using portable Node at %PORTABLE_NODE_DIR%

REM --- Add Ghostscript to PATH ---
set "DEPS=%USERPROFILE%\Downloads\documind-deps"
if exist "%DEPS%\ghostscript" (
    for /r "%DEPS%\ghostscript" %%F in (gswin64c.exe) do (
        set "PATH=%%~dpF;%PATH%"
    )
)

REM --- Add GraphicsMagick to PATH (project GM folder or documind-deps) ---
if exist "%~dp0GM\gm.exe" (
    set "PATH=%~dp0GM;%PATH%"
) else if exist "%DEPS%\graphicsmagick" (
    for /r "%DEPS%\graphicsmagick" %%F in (gm.exe) do (
        set "PATH=%%~dpF;%PATH%"
    )
)

REM --- Optional LibreOffice: .\LibreOffice\program\ OR PortableApps .\LibreOfficePortable\ (nested program\soffice.exe) ---
if exist "%~dp0LibreOffice\program\soffice.exe" (
    set "PATH=%~dp0LibreOffice\program;%PATH%"
) else if exist "%~dp0LibreOfficePortable\" (
    for /r "%~dp0LibreOfficePortable" %%F in (soffice.exe) do (
        set "PATH=%%~dpF;%PATH%"
        goto :documind_lo_path_done
    )
)
:documind_lo_path_done

REM --- Optional MSYS2 next to this repo (this tree uses MSYS2\ not msys64\) ---
if exist "%~dp0MSYS2\mingw64\bin\" (
    set "PATH=%~dp0MSYS2\mingw64\bin;%PATH%"
) else if exist "%~dp0MSYS2\ucrt64\bin\" (
    set "PATH=%~dp0MSYS2\ucrt64\bin;%PATH%"
) else if exist "%~dp0MSYS2\clang64\bin\" (
    set "PATH=%~dp0MSYS2\clang64\bin;%PATH%"
) else if exist "%~dp0msys64\mingw64\bin\" (
    set "PATH=%~dp0msys64\mingw64\bin;%PATH%"
)

REM --- LLM-API-Key-Proxy in a second window (no Docker). Skip: set DOCUMIND_SKIP_LLM_PROXY=1 before this batch ---
if defined DOCUMIND_SKIP_LLM_PROXY goto after_llm_proxy
if exist "%~dp0LLM-API-Key-Proxy-source code\requirements.txt" if exist "%~dp0scripts\start-llm-api-proxy.bat" (
    echo Starting LLM-API-Key-Proxy in another window ^(first run: wait for pip install there^)...
    start "LLM-API-Key-Proxy" "%~dp0scripts\start-llm-api-proxy.bat"
    timeout /t 4 /nobreak >nul
)
:after_llm_proxy

echo.
echo Starting Documind GUI...
echo.
node "%~dp0gui\server.js"
