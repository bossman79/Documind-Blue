#Requires -Version 5.1
<#
.SYNOPSIS
  Test DWG -> PDF using ONLY Autodesk AccoreConsole.exe (no cad2x, no LibreOffice).

.DESCRIPTION
  Finds accoreconsole.exe under Program Files\Autodesk\*, or uses DOCUMIND_ACCORECONSOLE_PATH.
  Builds a .scr from DOCUMIND_ACCORECONSOLE_SCRIPT (substitutes PDF_FILE_NAME_HERE / {{OUTPUT_PDF}})
  or uses the same built-in -EXPORT sequence as Documind core.

.PARAMETER Dwg
  Path to .dwg (default: repo root 31510194_acm_003_00.dwg if present).

.PARAMETER OutDir
  Where to write the PDF (default: tools/accordwg-preview under repo).
#>
param(
  [string] $Dwg = "",
  [string] $OutDir = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent

if (-not $Dwg) {
  $Dwg = Join-Path $Root "31510194_acm_003_00.dwg"
}
$Dwg = (Resolve-Path -LiteralPath $Dwg).Path

if (-not $OutDir) {
  $OutDir = Join-Path $Root "tools\accordwg-preview"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$Accore = $env:DOCUMIND_ACCORECONSOLE_PATH
if (-not $Accore -or -not (Test-Path -LiteralPath $Accore)) {
  $all = New-Object System.Collections.Generic.List[string]
  foreach ($rootDir in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if (-not $rootDir) { continue }
    $autodesk = Join-Path $rootDir "Autodesk"
    if (-not (Test-Path -LiteralPath $autodesk)) { continue }
    $dirs = Get-ChildItem -LiteralPath $autodesk -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
    foreach ($d in $dirs) {
      $cand = Join-Path $d.FullName "accoreconsole.exe"
      if (Test-Path -LiteralPath $cand) { [void]$all.Add($cand) }
    }
  }
  $prefer = $all | Where-Object { $_ -notmatch 'TrueView' }
  $pool = @($prefer)
  if ($pool.Count -eq 0) { $pool = @($all) }
  $Accore = ($pool | Select-Object -First 1)
}

if (-not $Accore -or -not (Test-Path -LiteralPath $Accore)) {
  Write-Host "accoreconsole.exe was not found. Install AutoCAD (or LT if your SKU includes Core Console) or set DOCUMIND_ACCORECONSOLE_PATH." -ForegroundColor Red
  Write-Host "This script does not run LibreOffice or cad2x." -ForegroundColor Yellow
  exit 1
}

$stem = [System.IO.Path]::GetFileNameWithoutExtension($Dwg)
$pdf = Join-Path $OutDir "${stem}_accore_test.pdf"
$pdfFwd = $pdf.Replace("\", "/")
$pdfQuoted = '"' + $pdfFwd + '"'
$scrBase = Join-Path $env:TEMP ("documind_accore_test_{0}" -f [Guid]::NewGuid().ToString("n").Substring(0, 8))
$scr = "$scrBase.scr"

$templatePath = $env:DOCUMIND_ACCORECONSOLE_SCRIPT
$useTemplate = $templatePath -and (Test-Path -LiteralPath $templatePath)
if ($useTemplate) {
  $body = Get-Content -LiteralPath $templatePath -Raw -Encoding UTF8
  $pdfWin = $pdf
  $body = $body.Replace("{{OUTPUT_PDF}}", $pdfQuoted)
  $body = $body.Replace("{{OUTPUT_PDF_UNQUOTED}}", $pdfFwd)
  $body = $body.Replace("{{OUTPUT_PDF_WINDOWS}}", $pdfWin)
  $body = $body.Replace("PDF_FILE_NAME_HERE", $pdfQuoted)
  [System.IO.File]::WriteAllText($scr, $body, (New-Object System.Text.UTF8Encoding $false))
  $plotStrategies = @("") 
} elseif ($null -ne $env:DOCUMIND_ACCORE_EXPORT_PLOT_AREA) {
  $plotStrategies = @($env:DOCUMIND_ACCORE_EXPORT_PLOT_AREA.Trim())
} else {
  $plotStrategies = @("Extents", "")
}

function Write-DocumindAccoreBuiltInScr {
  param([string]$PlotLine, [string]$ScrPath, [string]$PdfQuoted, [string]$LayoutEnv)
  $lines = New-Object System.Collections.Generic.List[string]
  [void]$lines.Add("_FILEDIA")
  [void]$lines.Add("0")
  [void]$lines.Add("_CMDDIA")
  [void]$lines.Add("0")
  
  # Pre-process: AUDIT and PURGE to speed up conversion
  [void]$lines.Add("_AUDIT")
  [void]$lines.Add("Y")
  [void]$lines.Add("_-PURGE")
  [void]$lines.Add("A")
  [void]$lines.Add("*")
  [void]$lines.Add("N")
  
  if ($LayoutEnv) {
    [void]$lines.Add("_-LAYOUT")
    [void]$lines.Add("S")
    [void]$lines.Add($LayoutEnv)
    [void]$lines.Add("_ZOOM")
    [void]$lines.Add("E")
  } else {
    [void]$lines.Add("_ZOOM")
    [void]$lines.Add("E")
  }
  [void]$lines.Add("_-EXPORT")
  [void]$lines.Add("Pdf")
  [void]$lines.Add("")
  [void]$lines.Add("N")
  [void]$lines.Add($PdfQuoted)
  [void]$lines.Add("_QUIT")
  [void]$lines.Add("Y")
  $text = ($lines -join "`r`n") + "`r`n"
  [System.IO.File]::WriteAllText($ScrPath, $text, (New-Object System.Text.UTF8Encoding $false))
}

Remove-Item -LiteralPath $pdf -Force -ErrorAction SilentlyContinue

$DwgForAccore = $Dwg
$workDwg = $null
if ($env:DOCUMIND_ACCORE_SKIP_INPUT_COPY -ne "1") {
  $workDwg = Join-Path $env:TEMP ("documind_accore_test_{0}.dwg" -f [Guid]::NewGuid().ToString("n").Substring(0, 8))
  Copy-Item -LiteralPath $Dwg -Destination $workDwg -Force
  $DwgForAccore = $workDwg
}

Write-Host "AccoreConsole: $Accore"
Write-Host "DWG source:  $Dwg"
Write-Host "DWG /i:      $DwgForAccore"
Write-Host "PDF out:     $pdf"
Write-Host ""

$code = -1
$pdfOk = $false
$si = 0
foreach ($plotLine in $plotStrategies) {
  $si++
  if (-not $useTemplate) {
    Write-DocumindAccoreBuiltInScr -PlotLine $plotLine -ScrPath $scr -PdfQuoted $pdfQuoted -LayoutEnv $env:DOCUMIND_ACCORE_LAYOUT
  }
  $label = if ($plotLine -eq "") { "(blank)" } else { $plotLine }
  Write-Host "Script:      $scr  [plot $si/$($plotStrategies.Count): $label]"
  Remove-Item -LiteralPath $pdf -Force -ErrorAction SilentlyContinue
  try {
    $accArgs = New-Object System.Collections.Generic.List[string]
    if ($env:DOCUMIND_ACCORE_USE_ISOLATE -eq "1") { [void]$accArgs.Add("/isolate") }
    if ($env:DOCUMIND_ACCORE_LANG) {
      [void]$accArgs.Add("/l")
      [void]$accArgs.Add($env:DOCUMIND_ACCORE_LANG.Trim())
    }
    [void]$accArgs.Add("/i")
    [void]$accArgs.Add($DwgForAccore)
    [void]$accArgs.Add("/s")
    [void]$accArgs.Add($scr)
    $proc = Start-Process -FilePath $Accore -ArgumentList $accArgs -Wait -PassThru -NoNewWindow
    $code = $proc.ExitCode
  } finally { }
  if (Test-Path -LiteralPath $pdf) {
    $pdfOk = $true
    break
  }
  if ($si -lt $plotStrategies.Count) {
    Write-Host "Strategy failed; trying alternate plot line…" -ForegroundColor Yellow
  }
}

try {
  if ($workDwg -and (Test-Path -LiteralPath $workDwg)) {
    Remove-Item -LiteralPath $workDwg -Force -ErrorAction SilentlyContinue
  }
} catch { }

if (-not $pdfOk) {
  Write-Host "FAILED: PDF not created (process exit $code). For plot-style scripts set DOCUMIND_ACCORECONSOLE_SCRIPT to your .scr and check Layout/PC3 names." -ForegroundColor Red
  exit 2
}

$len = (Get-Item -LiteralPath $pdf).Length
Write-Host "OK: $len bytes -> $pdf" -ForegroundColor Green
exit 0
