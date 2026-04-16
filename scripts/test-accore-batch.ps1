#Requires -Version 5.1
<#
.SYNOPSIS
  Test batch DWG processing with conversion counter optimization

.DESCRIPTION
  Processes the same DWG file multiple times to test the conversion counter
  that forces cleanup delays after every N conversions to prevent memory leaks.
#>
param(
  [int] $Count = 6,  # Process 6 times to trigger the cleanup (threshold is 5)
  [string] $Dwg = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent

if (-not $Dwg) {
  $Dwg = Join-Path $Root "31510194_acm_003_00.dwg"
}

if (-not (Test-Path -LiteralPath $Dwg)) {
  Write-Host "DWG file not found: $Dwg" -ForegroundColor Red
  exit 1
}

Write-Host "Testing batch DWG processing with conversion counter optimization" -ForegroundColor Cyan
Write-Host "DWG file: $Dwg" -ForegroundColor Cyan
Write-Host "Iterations: $Count" -ForegroundColor Cyan
Write-Host "Conversion threshold: 5 (cleanup delay triggers after 5th conversion)" -ForegroundColor Cyan
Write-Host ""

# Build the project first
Write-Host "Building project..." -ForegroundColor Yellow
$buildScript = Join-Path $Root "scripts\build-core.ps1"
& powershell -ExecutionPolicy Bypass -File $buildScript
if ($LASTEXITCODE -ne 0) {
  Write-Host "Build failed" -ForegroundColor Red
  exit 1
}
Write-Host "Build complete" -ForegroundColor Green
Write-Host ""

# Create a simple Node.js test script
$testScript = @"
const { convertDwgToOrientedPngs } = require('./dist/index.js');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');

async function testBatch() {
  const dwgPath = process.argv[2];
  const count = parseInt(process.argv[3], 10);
  
  console.log('Starting batch conversion test...');
  const startTime = Date.now();
  
  for (let i = 1; i <= count; i++) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'documind-batch-test-'));
    try {
      console.log(\`\n[Conversion \${i}/\${count}] Processing...\`);
      const convStart = Date.now();
      
      const result = await convertDwgToOrientedPngs({
        localPath: dwgPath,
        tempDir: tempDir,
        metadataOnly: true,
        accore: undefined
      });
      
      const convTime = ((Date.now() - convStart) / 1000).toFixed(1);
      console.log(\`[Conversion \${i}/\${count}] Complete in \${convTime}s - \${result.totalSourceCount} pages\`);
      
      // Check if cleanup delay was triggered (after 5th conversion)
      if (i === 5) {
        console.log('[INFO] Conversion counter threshold reached - cleanup delay should trigger after this');
      }
    } catch (err) {
      console.error(\`[Conversion \${i}/\${count}] FAILED:\`, err.message);
      throw err;
    } finally {
      await fs.remove(tempDir).catch(() => {});
    }
  }
  
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(\`\nBatch test complete: \${count} conversions in \${totalTime}s\`);
  console.log(\`  Average: \${(totalTime / count).toFixed(1)}s per conversion\`);
}

testBatch().catch(err => {
  console.error('Batch test failed:', err);
  process.exit(1);
});
"@

$testScriptPath = Join-Path $Root "core\test-batch.js"
[System.IO.File]::WriteAllText($testScriptPath, $testScript, (New-Object System.Text.UTF8Encoding $false))

try {
  Write-Host "Running batch conversion test..." -ForegroundColor Yellow
  $nodeArgs = @($testScriptPath, $Dwg, $Count)
  & node $nodeArgs
  
  if ($LASTEXITCODE -eq 0) {
    Write-Host "`nBatch test PASSED" -ForegroundColor Green
  } else {
    Write-Host "`nBatch test FAILED (exit code: $LASTEXITCODE)" -ForegroundColor Red
    exit 1
  }
} finally {
  Remove-Item -LiteralPath $testScriptPath -Force -ErrorAction SilentlyContinue
}
