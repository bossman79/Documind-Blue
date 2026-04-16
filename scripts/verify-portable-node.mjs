/**
 * Quick sanity check: portable Node + ESM imports used by the GUI merge path.
 * Run: portable-node.bat scripts/verify-portable-node.mjs  (from repo root)
 */
import process from 'node:process';

console.log('node', process.version);

const mergeMod = await import('../gui/extractCsvSubmittalMerge.js');
if (typeof mergeMod.mergeExtractCsvIntoSubmittalWorkbook !== 'function') {
  console.error('FAIL: mergeExtractCsvIntoSubmittalWorkbook missing');
  process.exit(1);
}

const si = await import('../gui/submittalImport.js');
if (typeof si.parseTemplateSheet !== 'function') {
  console.error('FAIL: submittalImport.parseTemplateSheet missing');
  process.exit(1);
}

console.log('ok: extractCsvSubmittalMerge + submittalImport load');
