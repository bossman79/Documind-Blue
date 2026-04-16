@echo off
title LLM-API-Key-Proxy
setlocal EnableExtensions
cd /d "%~dp0..\LLM-API-Key-Proxy-source code"
if not exist "requirements.txt" (
  echo ERROR: requirements.txt not found in proxy folder.
  pause
  exit /b 1
)

REM venv lives under LocalAppData so paths stay short (LiteLLM has very deep files; avoids MAX_PATH on Windows)
set "VENV=%LOCALAPPDATA%\Documind\llm-proxy-venv"
if not exist "%VENV%\Scripts\python.exe" (
  echo Creating Python venv at:
  echo   %VENV%
  if not exist "%LOCALAPPDATA%\Documind" mkdir "%LOCALAPPDATA%\Documind"
  python -m venv "%VENV%" 2>nul
  if errorlevel 1 py -3 -m venv "%VENV%"
  if not exist "%VENV%\Scripts\pip.exe" (
    echo ERROR: Could not create venv. Install Python 3 and ensure python or py is on PATH.
    pause
    exit /b 1
  )
  echo Installing dependencies ^(first run may take a few minutes^)...
  call "%VENV%\Scripts\pip.exe" install -r requirements.txt
  if errorlevel 1 (
    echo.
    echo ERROR: pip install failed. If you still see "Long Path" / MAX_PATH errors, enable Windows long paths:
    echo   https://pip.pypa.io/warnings/enable-long-paths
    pause
    exit /b 1
  )
)

echo.
echo venv: %VENV%
echo LLM-API-Key-Proxy: http://127.0.0.1:8000/v1  ^(Documind Base URL + PROXY_API_KEY + model prefix^)
echo.
"%VENV%\Scripts\python.exe" src\proxy_app\main.py --host 127.0.0.1 --port 8000
if errorlevel 1 pause
