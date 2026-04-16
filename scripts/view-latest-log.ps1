$logDir = Join-Path $PSScriptRoot "..\logs"

if (-not (Test-Path $logDir)) {
    Write-Host "No logs directory found at: $logDir" -ForegroundColor Red
    exit 1
}

$latestLog = Get-ChildItem -Path $logDir -Filter "batch-*.log" | 
    Sort-Object LastWriteTime -Descending | 
    Select-Object -First 1

if ($null -eq $latestLog) {
    Write-Host "No log files found in: $logDir" -ForegroundColor Red
    exit 1
}

Write-Host "Latest log file: $($latestLog.FullName)" -ForegroundColor Green
Write-Host "Last modified: $($latestLog.LastWriteTime)" -ForegroundColor Cyan
Write-Host ""
Write-Host "=== LOG CONTENTS ===" -ForegroundColor Yellow
Write-Host ""

Get-Content $latestLog.FullName | ForEach-Object {
    try {
        $json = $_ | ConvertFrom-Json
        $color = switch ($json.level) {
            "ERROR" { "Red" }
            "WARN" { "Yellow" }
            "INFO" { "Green" }
            "DEBUG" { "Gray" }
            default { "White" }
        }
        Write-Host "[$($json.timestamp)] [$($json.level)] $($json.message)" -ForegroundColor $color
        if ($json.data) {
            Write-Host "  Data: $($json.data | ConvertTo-Json -Compress)" -ForegroundColor DarkGray
        }
    } catch {
        Write-Host $_ -ForegroundColor White
    }
}
