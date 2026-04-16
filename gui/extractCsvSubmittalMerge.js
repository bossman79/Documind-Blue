/**
 * Append Documind extraction CSV rows onto an existing Vendor Submittal workbook
 * (sheet "Submittal"), mapping columns by the same canonical headers as submittal merge.
 *
 * Uses ExcelJS so workbook structure round-trips. When finding where to append, formula
 * cells are ignored — only literal values in mapped columns count — so copied formulas
 * down the sheet do not push the append point hundreds of rows down. New values are
 * written only into the template columns (same as the header row); formula columns are
 * left untouched on those rows.
 */
import ExcelJS from 'exceljs';
import {
  parseTemplateFromAoa,
  buildColMapFromHeaderRow,
  findBestHeaderRow,
  headerToCanonical,
  canonicalRowToTemplateArray,
} from './submittalImport.js';

const HEADER_SCAN_ROWS = 80;
const MAX_ROWS_BELOW_HEADER = 2500;

function aoaCellStr(v) {
  if (v == null || v === '') return '';
  return String(v).trim();
}

/**
 * RFC-style CSV parse (quotes, commas, newlines).
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsvText(text) {
  const t = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQuotes) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else if (c !== '\r') {
      cur += c;
    }
  }
  row.push(cur);
  if (row.length > 1 || (row[0] != null && String(row[0]).trim() !== '')) {
    rows.push(row);
  }
  return rows;
}

function resolveSubmittalSheetName(wb) {
  const sheets = wb.worksheets || [];
  if (!sheets.length) throw new Error('Workbook has no worksheets.');
  const names = sheets.map((s) => s.name);
  const exact = names.find((n) => n.trim().toLowerCase() === 'submittal');
  if (exact) return exact;
  const fuzzy = names.find((n) => /submittal/i.test(n));
  if (fuzzy) return fuzzy;
  throw new Error('No worksheet named "Submittal" was found. Rename or add a sheet with that name.');
}

function excelCellToString(cell) {
  if (!cell || cell.value == null || cell.value === '') return '';
  const v = cell.value;
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    if (v.richText && Array.isArray(v.richText)) {
      return v.richText.map((p) => (p && p.text) || '').join('').trim();
    }
    if (v.text != null) return String(v.text).trim();
    if (v.hyperlink && v.text != null) return String(v.text).trim();
    if ('formula' in v && v.result != null && v.result !== '') return String(v.result).trim();
    if ('sharedFormula' in v && v.result != null && v.result !== '') return String(v.result).trim();
  }
  return String(v).trim();
}

/** True if this cell is driven by a formula (do not use its displayed value to infer "data row"). */
function excelCellIsFormula(cell) {
  if (!cell) return false;
  if (typeof cell.formula === 'string' && cell.formula.length > 0) return true;
  const v = cell.value;
  if (v && typeof v === 'object') {
    if (typeof v.formula === 'string' && v.formula.length > 0) return true;
    if (typeof v.sharedFormula === 'string' && v.sharedFormula.length > 0) return true;
  }
  if (cell.type === ExcelJS.ValueType.Formula) return true;
  return false;
}

/**
 * Read a compact grid for header detection only (avoids materializing sheet-wide used range).
 * @param {import('exceljs').Worksheet} worksheet
 * @param {number} maxRow1 — inclusive, 1-based
 * @param {number} maxCol — inclusive, 1-based
 */
function readAoaRange(worksheet, maxRow1, maxCol) {
  const aoa = [];
  const limit = Math.max(1, maxRow1);
  for (let r = 1; r <= limit; r++) {
    const row = worksheet.getRow(r);
    const arr = [];
    for (let c = 1; c <= maxCol; c++) {
      arr.push(excelCellToString(row.getCell(c)));
    }
    aoa.push(arr);
  }
  return aoa;
}

function resolveScanExtents(worksheet) {
  const dim = worksheet.dimensions;
  let maxCol = 40;
  if (dim && dim.right > 0) maxCol = Math.min(dim.right, 256);
  else {
    worksheet.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (_cell, colNumber) => {
        maxCol = Math.max(maxCol, Math.min(colNumber, 256));
      });
    });
  }
  const headerLast = Math.min(HEADER_SCAN_ROWS, dim?.bottom ?? HEADER_SCAN_ROWS, worksheet.rowCount || HEADER_SCAN_ROWS);
  return { maxCol, headerLastRow: Math.max(1, headerLast) };
}

/**
 * Last Excel row (1-based) that counts as a body row: any mapped column has a non-empty
 * literal (non-formula) value. Formula-only cells are skipped so filled-down columns do
 * not extend the table.
 * @param {import('exceljs').Row} row
 * @param {Map<number, string>} colMap — 0-based column index -> canonical
 */
function rowHasLiteralMappedValue(row, colMap) {
  for (const col0 of colMap.keys()) {
    const cell = row.getCell(col0 + 1);
    if (excelCellIsFormula(cell)) continue;
    if (excelCellToString(cell)) return true;
  }
  return false;
}

/**
 * @param {import('exceljs').Worksheet} worksheet
 * @param {number} headerRow0 — 0-based index in sheet (row 1 = index 0)
 * @param {Map<number, string>} colMap
 * @returns {number} Excel row index (1-based) of last body row; equals header row if none
 */
function findLastBodyDataExcelRow(worksheet, headerRow0, colMap) {
  const headerExcelRow = headerRow0 + 1;
  const dim = worksheet.dimensions;
  const dimBottom = dim?.bottom ?? headerExcelRow + MAX_ROWS_BELOW_HEADER;
  const scanEnd = Math.min(dimBottom, headerExcelRow + MAX_ROWS_BELOW_HEADER);
  let lastExcel = headerExcelRow;
  for (let er = headerExcelRow + 1; er <= scanEnd; er++) {
    const row = worksheet.getRow(er);
    if (rowHasLiteralMappedValue(row, colMap)) {
      lastExcel = er;
    }
  }
  return lastExcel;
}

function padRow(arr, width) {
  const out = (arr || []).slice();
  while (out.length < width) out.push('');
  return out;
}

/** @param {import('exceljs').Row} row */
function rowMaxUsedColumn(row) {
  let m = 0;
  row.eachCell({ includeEmpty: false }, (_cell, colNumber) => {
    m = Math.max(m, colNumber);
  });
  return m;
}

function clonePart(v) {
  if (v == null) return undefined;
  if (typeof v !== 'object') return v;
  try {
    if (typeof structuredClone === 'function') return structuredClone(v);
  } catch {
    /* fall through */
  }
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return undefined;
  }
}

function copyCellFormatting(sourceCell, targetCell) {
  if (!sourceCell) return;
  const font = clonePart(sourceCell.font);
  if (font) targetCell.font = font;
  const alignment = clonePart(sourceCell.alignment);
  if (alignment) targetCell.alignment = alignment;
  const border = clonePart(sourceCell.border);
  if (border) targetCell.border = border;
  const fill = clonePart(sourceCell.fill);
  if (fill) targetCell.fill = fill;
  if (sourceCell.numFmt != null && sourceCell.numFmt !== '') {
    targetCell.numFmt = sourceCell.numFmt;
  }
  const protection = clonePart(sourceCell.protection);
  if (protection) targetCell.protection = protection;
}

function cellHasFormatting(cell) {
  if (!cell) return false;
  return !!(
    cell.font ||
    cell.fill ||
    cell.border ||
    cell.alignment ||
    (cell.numFmt != null && cell.numFmt !== '')
  );
}

/**
 * Copy display formatting from a body-row cell. Body cells often rely on table/theme
 * styles without setting `cell.font` etc., so we also clone `cell.style` when ExcelJS exposes it.
 * Do not fall back to the header row when a body template row exists — that was forcing header look.
 */
function copyStyleFromBodyCell(sourceCell, targetCell) {
  try {
    const st = sourceCell.style;
    if (st && typeof st === 'object' && Object.keys(st).length > 0) {
      const cloned = clonePart(st);
      if (cloned) targetCell.style = cloned;
    }
  } catch {
    /* style getter may throw for some cells */
  }
  copyCellFormatting(sourceCell, targetCell);
}

/**
 * @param {Buffer|Uint8Array|ArrayBuffer} workbookBuffer
 * @param {string} csvText
 * @returns {Promise<Buffer>}
 */
export async function mergeExtractCsvIntoSubmittalWorkbook(workbookBuffer, csvText) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(workbookBuffer);
  const sheetName = resolveSubmittalSheetName(wb);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw new Error(`Missing sheet: ${sheetName}`);

  const { maxCol, headerLastRow } = resolveScanExtents(ws);
  const thinAoa = readAoaRange(ws, headerLastRow, maxCol);
  const { score } = findBestHeaderRow(thinAoa);
  if (score < 2) {
    throw new Error(
      'The Submittal sheet needs a clear header row (e.g. Filename, Drawing number, Description).',
    );
  }

  const parsed = parseTemplateFromAoa(thinAoa, sheetName);
  const headerRow = parsed.headerRowIndex;
  const colMap = buildColMapFromHeaderRow(thinAoa, headerRow);
  if (colMap.size === 0) {
    throw new Error('Could not map columns from the Submittal header row.');
  }

  const csvRows = parseCsvText(csvText);
  if (csvRows.length < 2) {
    throw new Error('Extraction CSV is empty or has no data rows.');
  }

  const headerCells = csvRows[0];
  /** @type {Map<number, string>} */
  const csvIndexToCanonical = new Map();
  headerCells.forEach((h, idx) => {
    const c = headerToCanonical(h);
    if (c) csvIndexToCanonical.set(idx, c);
  });
  if (csvIndexToCanonical.size === 0) {
    throw new Error('CSV headers do not match known extraction columns.');
  }

  const dataObjects = [];
  for (let r = 1; r < csvRows.length; r++) {
    const line = csvRows[r];
    if (!line || !line.some((x) => aoaCellStr(x))) continue;
    /** @type {Record<string, string>} */
    const obj = {};
    for (const [idx, canonical] of csvIndexToCanonical) {
      obj[canonical] = line[idx] != null ? aoaCellStr(line[idx]) : '';
    }
    dataObjects.push(obj);
  }
  if (dataObjects.length === 0) {
    throw new Error('No non-empty data rows in the extraction CSV.');
  }

  const newRows = dataObjects.map((obj) =>
    canonicalRowToTemplateArray(obj, parsed.headers, parsed.colCanonical),
  );

  const lastBodyExcelRow = findLastBodyDataExcelRow(ws, headerRow, colMap);
  const headerExcelRow = headerRow + 1;
  const styleSourceExcelRow =
    lastBodyExcelRow > headerExcelRow ? lastBodyExcelRow : headerExcelRow;
  const styleSourceRow = ws.getRow(styleSourceExcelRow);
  const headerStyleRow = ws.getRow(headerExcelRow);

  const colCount = Math.max(
    parsed.headers.length,
    rowMaxUsedColumn(styleSourceRow),
    rowMaxUsedColumn(headerStyleRow),
    ...newRows.map((r) => r.length),
    maxCol,
  );

  const startExcelRow = lastBodyExcelRow + 1;
  const hasBodyRowsBelowHeader = lastBodyExcelRow > headerExcelRow;

  for (let i = 0; i < newRows.length; i++) {
    const values = padRow(newRows[i], colCount);
    const targetRow = ws.getRow(startExcelRow + i);
    if (styleSourceRow.height != null) {
      targetRow.height = styleSourceRow.height;
    }
    for (let c = 1; c <= colCount; c++) {
      const tCell = targetRow.getCell(c);
      if (excelCellIsFormula(tCell)) continue;
      const sCell = styleSourceRow.getCell(c);
      const hCell = headerStyleRow.getCell(c);
      tCell.value = values[c - 1] ?? '';
      if (hasBodyRowsBelowHeader) {
        copyStyleFromBodyCell(sCell, tCell);
      } else if (cellHasFormatting(hCell)) {
        copyCellFormatting(hCell, tCell);
      }
    }
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
