# No admin: download PortableApps LibreOffice .paf.exe and unpack with 7-Zip's standalone 7zr.exe
# (no MSI / msiexec). Produces .\LibreOffice\program\soffice.exe for start-gui.bat.
# ~205 MB app + tiny 7zr; MPL-2.0 (LibreOffice) / LGPL (7-Zip 7zr) - see README-documind.txt in output folder.
param(
    [switch]$Force,
    [string]$FromPafPath = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $Root "LibreOffice"
$DestSoffice = Join-Path $Dest "program\soffice.exe"

if ((Test-Path $DestSoffice) -and -not $Force) {
    Write-Host "Already present: $DestSoffice (use -Force to re-download)"
    exit 0
}

if ($env:OS -ne "Windows_NT") {
    Write-Error "This script targets Windows. On Linux/macOS install LibreOffice with your package manager."
}

$PafName = "LibreOfficePortableLegacyWin7_25.2.7_MultilingualStandard.paf.exe"
$PafUrl = "https://downloads.sourceforge.net/project/portableapps/LibreOffice%20Portable/$PafName"
$SevenZrUrl = "https://www.7-zip.org/a/7zr.exe"

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) "documind-lo-pa"
$SevenZr = Join-Path $Tmp "7zr.exe"
$UnpackRoot = Join-Path $Tmp "unpack"

function Find-SofficeInTree([string]$root) {
    Get-ChildItem -LiteralPath $root -Recurse -Filter "soffice.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\program\\soffice\.exe$' } |
        Select-Object -First 1
}

function Get-SevenZr([string]$dir) {
    $local = Join-Path $dir "7zr.exe"
    if (Test-Path $local) { return $local }
    Write-Host "Downloading 7zr.exe (official minimal 7-Zip, no install)..."
    Invoke-WebRequest -Uri $SevenZrUrl -OutFile $local -UseBasicParsing
    return $local
}

function Invoke-SevenExtract([string]$sevenZr, [string]$archive, [string]$outDir) {
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    $outArg = "-o" + $outDir.TrimEnd("\")
    & $sevenZr x $archive $outArg -y
    if ($LASTEXITCODE -ne 0) {
        throw "7zr failed (exit $LASTEXITCODE) on: $archive"
    }
}

New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
if ($Force) {
    Remove-Item $UnpackRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$sevenZr = Get-SevenZr $Tmp

if ($FromPafPath) {
    if (-not (Test-Path $FromPafPath)) { Write-Error "FromPafPath not found: $FromPafPath" }
    $pafPath = (Resolve-Path $FromPafPath).Path
} else {
    $pafPath = Join-Path $Tmp $PafName
    if ($Force -or -not (Test-Path $pafPath)) {
        Write-Host "Downloading PortableApps LibreOffice (no admin installer)..."
        Write-Host "  $PafUrl"
        Invoke-WebRequest -Uri $PafUrl -OutFile $pafPath -UseBasicParsing
    }
}

Write-Host "Extracting .paf.exe with 7zr (first pass)..."
Remove-Item $UnpackRoot -Recurse -Force -ErrorAction SilentlyContinue
Invoke-SevenExtract $sevenZr $pafPath $UnpackRoot

$soffice = Find-SofficeInTree $UnpackRoot

# Nested 7z payloads (common for NSIS / PortableApps)
if (-not $soffice) {
    Write-Host "Looking for nested .7z inside the installer..."
    $nested = Get-ChildItem -LiteralPath $UnpackRoot -Recurse -Filter "*.7z" -File -ErrorAction SilentlyContinue |
        Sort-Object Length -Descending |
        Select-Object -First 12
    $i = 0
    foreach ($nz in $nested) {
        $subOut = Join-Path $nz.DirectoryName ("_7z_expand_" + $i)
        $i++
        try {
            Invoke-SevenExtract $sevenZr $nz.FullName $subOut
        } catch {
            continue
        }
        $soffice = Find-SofficeInTree $UnpackRoot
        if ($soffice) { break }
    }
}

if (-not $soffice) {
    Write-Host ""
    Write-Host "Automatic extract did not find soffice.exe. Fallbacks (no admin):"
    Write-Host "  1) winget install TheDocumentFoundation.LibreOffice --scope user"
    Write-Host "     (installs under your profile; Documind already checks LocalAppData\Programs\LibreOffice.)"
    Write-Host "  2) Install 7-Zip File Manager (user installer), right-click the .paf.exe -> Extract to *,"
    Write-Host "     then run: scripts\download-libreoffice-portable.ps1 -FromPafPath `"path\to\$PafName`" -Force"
    Write-Host "  3) Run the .paf.exe GUI once and install to this folder, then run this script with -Force"
    Write-Error "soffice.exe not found after extraction. See messages above."
}

$loRoot = $soffice.Directory.Parent.FullName
Write-Host "Copying LibreOffice app tree to:`n  $Dest"

if (Test-Path $Dest) {
    Remove-Item $Dest -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Get-ChildItem -LiteralPath $loRoot | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Dest $_.Name) -Recurse -Force
}

$readme = @"
PortableApps.com LibreOffice package unpacked for Documind (no admin).
LibreOffice: MPL-2.0 - https://www.libreoffice.org/
PortableApps wrapper: https://portableapps.com/apps/office/libreoffice_portable
7zr used to extract: LGPL (7-Zip) - https://www.7-zip.org/

Do not commit this folder; it is in .gitignore.
"@
Set-Content -Path (Join-Path $Dest "README-documind.txt") -Value $readme -Encoding UTF8

if (-not (Test-Path $DestSoffice)) {
    Write-Error "Expected $DestSoffice after copy."
}

Write-Host "Done. $DestSoffice"
Write-Host "Run start-gui.bat; it prepends LibreOffice\program to PATH."
