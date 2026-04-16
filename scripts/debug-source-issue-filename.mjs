import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';
import {
  pickBestSheetForData,
  buildColMapFromHeaderRow,
  extractCanonicalRows,
} from '../gui/submittalImport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function dump(file, label) {
  const p = path.join(root, file);
  const wb = XLSX.readFile(p, { cellDates: true });
  const { name, aoa, headerRow, score } = pickBestSheetForData(wb);
  const row = aoa[headerRow];
  console.log(`\n=== ${label} | ${file}`);
  console.log('sheet:', name, 'headerRow:', headerRow, 'score:', score);
  console.log('headers:', row);
  const map = buildColMapFromHeaderRow(aoa, headerRow);
  console.log('colMap canonicals:', [...new Set([...map.values()])]);
  const rows = extractCanonicalRows(aoa, headerRow, map);
  const uniqIss = [...new Set(rows.map((r) => String(r.issueStatus || '').trim()).filter(Boolean))];
  console.log('unique issueStatus:', uniqIss);
  const emptyIss = rows.filter((r) => !String(r.issueStatus || '').trim());
  const emptyFn = rows.filter((r) => !String(r.filename || '').trim());
  console.log('empty issueStatus:', emptyIss.length, '/', rows.length);
  console.log('empty filename:', emptyFn.length, '/', rows.length);
  if (emptyFn[0]) console.log('sample empty filename row:', emptyFn[0]);
  if (emptyIss[0]) console.log('sample empty issue row:', emptyIss[0]);
}

dump("Transmittal C-02-0009-014 FM3 Feed GA's - Alamo (ACC32 FM3).xlsx", 'transmittal');
dump('C-02-0009 - Buzzi Alamo FM3 Drawing List - 03-20-2026.xlsx', 'drawing list');
