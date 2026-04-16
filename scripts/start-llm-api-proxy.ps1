# Starts LLM-API-Key-Proxy from the bundled source tree (no Docker, user-level venv).
# venv is under LocalAppData (short path) — LiteLLM ships very deep paths that break MAX_PATH inside the repo tree on Windows.
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ProxyDir = Join-Path $RepoRoot "LLM-API-Key-Proxy-source code"
if (-not (Test-Path -LiteralPath $ProxyDir)) {
  Write-Error "Proxy folder not found: $ProxyDir"
}
Set-Location -LiteralPath $ProxyDir

$venvRoot = Join-Path $env:LOCALAPPDATA "Documind\llm-proxy-venv"
$venvPython = Join-Path $venvRoot "Scripts\python.exe"
$venvPip = Join-Path $venvRoot "Scripts\pip.exe"

if (-not (Test-Path -LiteralPath $venvPython)) {
  $null = New-Item -ItemType Directory -Force -Path (Split-Path $venvRoot -Parent)
  $created = $false
  if (Get-Command py -ErrorAction SilentlyContinue) {
    py -3 -m venv $venvRoot
    if ($LASTEXITCODE -eq 0) { $created = $true }
  }
  if (-not $created) {
    python -m venv $venvRoot
  }
  if (-not (Test-Path -LiteralPath $venvPip)) {
    Write-Error "Could not create venv at $venvRoot. Install Python 3 and ensure python or py works."
  }
  Write-Host "Installing dependencies into $venvRoot (first run may take a few minutes)..."
  & $venvPip install -r requirements.txt
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "If install failed with path length errors, enable Windows long paths: https://pip.pypa.io/warnings/enable-long-paths"
    exit $LASTEXITCODE
  }
}

Write-Host "venv: $venvRoot" -ForegroundColor DarkGray
Write-Host "Starting LLM-API-Key-Proxy on http://127.0.0.1:8000/v1 (configure Documind Base URL + PROXY_API_KEY)." -ForegroundColor Cyan
& $venvPython src\proxy_app\main.py --host 127.0.0.1 --port 8000
