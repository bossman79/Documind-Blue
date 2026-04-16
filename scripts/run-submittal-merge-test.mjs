import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';
import { mergeTransmittalsToSubmittal } from '../gui/submittalImport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const drawing = path.join(root, 'C-02-0009 - Buzzi Alamo FM3 Drawing List - 03-20-2026.xlsx');
const transmittal = path.join(
  root,
  "Transmittal C-02-0009-014 FM3 Feed GA's - Alamo (ACC32 FM3).xlsx",
);
const template = path.join(root, 'Vender Submittal Sheet.xlsx');

for (const p of [drawing, transmittal, template]) {
  if (!fs.existsSync(p)) {
    console.error('Missing file:', p);
    process.exit(1);
  }
}

const { buffer, summary } = mergeTransmittalsToSubmittal([drawing, transmittal], template);
const outPath = path.join(root, 'submittal-merge-test-output.xlsx');
fs.writeFileSync(outPath, buffer);
console.log('Wrote', outPath);
console.log(JSON.stringify(summary, null, 2));

const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
const sn = wb.SheetNames[0];
const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });
const headerIdx = aoa.findIndex(
  (row) => row && String(row[0]).toLowerCase().includes('filename'),
);
const hdr = headerIdx >= 0 ? aoa[headerIdx] : aoa[0];
const col = (sub) =>
  hdr.findIndex((h) => String(h).toLowerCase().includes(sub.toLowerCase()));
const iFile = col('filename');
const iIss = col('issue');
const iDoc = col('document');
const iDesc = col('description');

console.log('\nSample rows (first 8 non-empty data rows after header):');
let shown = 0;
for (let r = headerIdx + 1; r < aoa.length && shown < 8; r++) {
  const row = aoa[r];
  if (!row || !row.some((c) => String(c).trim())) continue;
  console.log({
    filename: row[iFile],
    issueStatus: row[iIss],
    documentType: row[iDoc],
    description: String(row[iDesc] || '').slice(0, 60),
  });
  shown++;
}
console.log('\nTotal sheet rows:', aoa.length);
