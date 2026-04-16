# Build core/dist with the portable Node in this repo (so npm lifecycle scripts find `node` on PATH).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$PortableRoot = Join-Path $Root "nodejs-portable"
$NodeDir = $null
if (Test-Path $PortableRoot) {
  Get-ChildItem -Path $PortableRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    if (Test-Path (Join-Path $_.FullName "node.exe")) {
      $NodeDir = $_.FullName
    }
  }
}
if (-not $NodeDir) {
  Write-Error "Portable Node not found. Unpack Node under: $PortableRoot (folder must contain node.exe)"
}
$env:Path = "$NodeDir;$env:Path"
Set-Location $Root
npm run build -w core
