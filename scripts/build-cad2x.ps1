# Obtain cad2x for Documind (Windows x64).
#
# Default: downloads the official prebuilt binary from orcastor/addon-previewer (same cad2x-converter
# upstream). A full compile from this repo requires Qt 5.12 + MinGW and building 3rdparty/qtbase first
# (see cad2x-converter-Source Code\README_en.md) - not automated here.
#
# Usage:
#   .\scripts\build-cad2x.ps1              # download to cad2x-converter-Source Code\output\cad2x.exe
#   .\scripts\build-cad2x.ps1 -Force       # re-download
#   .\scripts\build-cad2x.ps1 -FromSource  # run qmake + mingw32-make in source tree (requires toolchain)

param(
    [switch] $Force,
    [switch] $FromSource
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$CadRoot = Join-Path $Root "cad2x-converter-Source Code"
$OutDir = Join-Path $CadRoot "output"
$Exe = Join-Path $OutDir "cad2x.exe"
$DownloadUrl = "https://raw.githubusercontent.com/orcastor/addon-previewer/main/back/cad2x/win_x64/cad2x.exe"

if (-not (Test-Path $CadRoot)) {
    Write-Error "cad2x source folder not found: $CadRoot"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Copy-Cad2xMinGwRuntimeDlls {
    param([string]$Dest)
    $dlls = @(
        'libgcc_s_seh-1.dll',
        'libstdc++-6.dll',
        'libwinpthread-1.dll'
    )
    $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    # Repo uses MSYS2\ at project root (official installer layout); msys64 is a common alternate name.
    $searchRoots = @(
        (Join-Path $Root 'MSYS2\mingw64\bin'),
        (Join-Path $Root 'MSYS2\ucrt64\bin'),
        (Join-Path $Root 'MSYS2\clang64\bin'),
        (Join-Path $Root 'msys64\mingw64\bin'),
        (Join-Path $Root 'msys64\ucrt64\bin'),
        (Join-Path $Root 'msys64\clang64\bin')
    )
    $searchRoots += @(
        (Join-Path $env:ProgramFiles 'Git\mingw64\bin')
    )
    if ($pf86) {
        $searchRoots += (Join-Path $pf86 'Git\mingw64\bin')
    }
    $searchRoots += 'C:\msys64\mingw64\bin'
    $searchRoots += 'C:\Qt\Tools\mingw730_64\bin'
    foreach ($src in $searchRoots) {
        if (-not $src -or -not (Test-Path $src)) { continue }
        $all = $true
        foreach ($d in $dlls) {
            if (-not (Test-Path (Join-Path $src $d))) { $all = $false; break }
        }
        if (-not $all) { continue }
        foreach ($d in $dlls) {
            Copy-Item -LiteralPath (Join-Path $src $d) -Destination (Join-Path $Dest $d) -Force
        }
        Write-Host "Copied MinGW runtime DLLs from: $src"
        return $true
    }
    return $false
}

if ($FromSource) {
    $qmake = Get-Command qmake -ErrorAction SilentlyContinue
    if (-not $qmake) {
        Write-Error "qmake not on PATH. Install Qt 5.12.12 (MinGW) and open the Qt shell, or omit -FromSource to download the prebuilt cad2x.exe."
    }
    $make = Get-Command mingw32-make -ErrorAction SilentlyContinue
    if (-not $make) { $make = Get-Command make -ErrorAction SilentlyContinue }
    if (-not $make) {
        Write-Error "mingw32-make or make not on PATH."
    }
    Push-Location $CadRoot
    try {
        & qmake -r
        if ($LASTEXITCODE -ne 0) { throw "qmake failed with exit $LASTEXITCODE" }
        & $make.Source -j $env:NUMBER_OF_PROCESSORS
        if ($LASTEXITCODE -ne 0) { throw "make failed with exit $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
    if (-not (Test-Path $Exe)) {
        Write-Warning "Expected $Exe after build - see cad2x README for qtbase prerequisites."
    }
    Write-Host "Build finished. Binary: $Exe"
    exit 0
}

if ((Test-Path $Exe) -and -not $Force) {
    Write-Host "cad2x.exe already present: $Exe (use -Force to re-download)"
} else {
    Write-Host 'Downloading prebuilt cad2x.exe from addon-previewer win_x64...'
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $Exe -UseBasicParsing
    $item = Get-Item $Exe
    Write-Host ('OK: ' + $item.FullName + ' [' + $item.Length + ' bytes]')
}

if (-not (Copy-Cad2xMinGwRuntimeDlls -Dest $OutDir)) {
    Write-Warning @"
Could not find MinGW DLLs to copy (libgcc_s_seh-1.dll, libstdc++-6.dll, libwinpthread-1.dll).
Install Git for Windows, or Qt Tools mingw730_64, or set DOCUMIND_MINGW64_BIN to a bin folder that contains them.
Documind core also prepends DOCUMIND_MINGW64_BIN / Git / Qt paths when spawning cad2x.
"@
} else {
    Write-Host "MinGW runtime DLLs are in: $OutDir"
}
