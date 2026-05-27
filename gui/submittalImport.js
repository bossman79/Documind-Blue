/**
 * Map drawing lists and transmittal spreadsheets to vendor submittal layout (no LLM).
 * Uses header synonym matching for source files and template columns.
 */
import XLSX from 'xlsx';

/** @typedef {{ canonical: string, colIndex: number, header: string }} TemplateColumn */

export function normalizeHeaderText(s) {
  if (s == null || s === '') return '';
  return String(s)
    .replace(/\u00a0/g, ' ')
    .replace(/\*/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*/g, '/');
}

/**
 * Longer aliases first so "drawing number" wins over "number".
 * @type {Record<string, string[]>}
 */
const CANONICAL_ALIASES = {
  filename: [
    'drawing number',
    'document number',
    'reference number',
    'sheet number',
    'dwg number',
    'dwg no',
    'drawing no',
    'doc number',
    'doc no',
    'document no',
    'sheet no',
    'sheet #',
    'drawing id',
    'detail number',
    'plan number',
    'item number',
    'item no',
    'transmittal no',
    'transmittal number',
    'sheet id',
    'file name',
    'filename',
    'number',
    'dwg',
    'id',
  ],
  issueStatus: ['issue status', 'purpose of issue', 'issue purpose', 'doc status'],
  tpc: [
    'tpc',
    'transmittal purpose code',
    'transmittal purpose',
    'transmittal purpose code (tpc)',
    'purpose code (tpc)',
  ],
  dsc: [
    'dsc',
    'document status code',
    'document status',
    'document status code (dsc)',
    'status code (dsc)',
  ],
  revision: [
    'revision',
    'rev',
    'rev no',
    'rev number',
    'r e v',
  ],
  revisionDate: [
    'revision date',
    'rev date',
    'date revised',
    'date of revision',
    'issue date',
    'transmittal date',
    'date',
  ],
  description: [
    'description/title',
    'description / title',
    'drawing title',
    'sheet title',
    'sheet name',
    'description',
    'title',
    'subject',
    'drawing description',
    'comments',
    'comment',
  ],
  vendorName: ['vendor name', 'supplier name', 'manufacturer', 'vendor'],
  discipline: ['discipline', 'disc', 'disciplines'],
  // Do not use 'document type' / 'doc type' here — they belong on documentType only (template column "Document Type").
  category: ['category', 'record category', 'doc category'],
  assetId: [
    // Asset variants
    'asset/id number',
    'asset / id number',
    'asset id',
    'asset number',
    'asset no',
    'asset #',
    'asset',
    // Part variants
    'part number',
    'part no',
    'part #',
    'part id',
    // Component variants
    'component id',
    'component number',
    'component no',
    'component #',
    // Equipment variants
    'equipment id',
    'equipment tag',
    'equipment number',
    'equipment no',
    'equipment #',
    'equip no',
    'equip number',
    'equip id',
    // Tag variants
    'tag',
    'tag number',
    'tag no',
    'tag #',
    'tag id',
    // Reference / identifier
    'reference number',
    'reference no',
    'reference #',
    'ref number',
    'ref no',
    'ref #',
    'identifier',
    'id',
    'id number',
    // SAP / ERP
    'material number',
    'material no',
    'matnr',
    // Model
    'model number',
    'model no',
    'model #',
  ],
  project: ['project', 'project number', 'project no', 'project name', 'job number', 'job no'],
  plant: ['plant', 'site', 'facility', 'location code'],
  location: ['location', 'area', 'building', 'room'],
  departmentCode: ['department code', 'dept code', 'department', 'dept'],
  documentType: ['document type', 'doc type', 'drawing type', 'sheet type', 'type'],
  scale: ['scale'],
  size: ['size', 'sheet size', 'paper size'],
};

/** Flat list: [canonical, alias] sorted by alias length descending */
function buildAliasPairs() {
  const pairs = [];
  for (const [canonical, list] of Object.entries(CANONICAL_ALIASES)) {
    for (const a of list) {
      pairs.push([canonical, normalizeHeaderText(a)]);
    }
  }
  pairs.sort((x, y) => y[1].length - x[1].length);
  return pairs;
}

const ALIAS_PAIRS = buildAliasPairs();

export function headerToCanonical(headerCell) {
  const n = normalizeHeaderText(headerCell);
  if (!n) return null;
  for (const [canonical, alias] of ALIAS_PAIRS) {
    if (!alias) continue;
    if (n === alias) return canonical;
    if (alias.length >= 4 && n.includes(alias)) return canonical;
  }
  if (n.length >= 4) {
    for (const [canonical, alias] of ALIAS_PAIRS) {
      if (alias.length >= 6 && alias.includes(n)) return canonical;
    }
  }
  return null;
}

export function scoreHeaderRow(row) {
  if (!Array.isArray(row)) return 0;
  const seen = new Set();
  let score = 0;
  for (const cell of row) {
    const c = headerToCanonical(cell);
    if (c && !seen.has(c)) {
      seen.add(c);
      score += 1;
    }
  }
  return score;
}

/**
 * @param {any[][]} aoa
 * @param {number} maxScan
 * @returns {{ headerRow: number, score: number }}
 */
export function findBestHeaderRow(aoa, maxScan = 45) {
  let best = { headerRow: 0, score: 0 };
  const limit = Math.min(maxScan, aoa.length);
  for (let r = 0; r < limit; r++) {
    const sc = scoreHeaderRow(aoa[r]);
    if (sc > best.score) best = { headerRow: r, score: sc };
  }
  return best;
}

/**
 * @param {any[][]} aoa
 * @param {number} headerRow
 * @returns {Map<number, string>} colIndex -> canonical
 */
export function buildColMapFromHeaderRow(aoa, headerRow) {
  const row = aoa[headerRow] || [];
  /** @type {Map<number, string>} */
  const map = new Map();
  const used = new Set();
  row.forEach((cell, colIndex) => {
    const c = headerToCanonical(cell);
    if (c && !used.has(c)) {
      used.add(c);
      map.set(colIndex, c);
    }
  });
  return map;
}

function cellStr(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && !Number.isNaN(v)) {
    if (XLSX.SSF && typeof XLSX.SSF.format === 'function') {
      try {
        return String(XLSX.SSF.format('General', v));
      } catch {
        return String(v);
      }
    }
    return String(v);
  }
  return String(v).trim();
}

function rowHasData(row, colMap) {
  if (!row || !colMap.size) return false;
  for (const col of colMap.keys()) {
    const t = cellStr(row[col]);
    if (t) return true;
  }
  return false;
}

/**
 * Prefer Filename, then supplier/client drawing numbers, sheet numbers, etc. (left-to-right within each rule).
 * @param {any[]} headerRow
 * @returns {number[]}
 */
/**
 * Some sheets have both a short "DSC" / "TPC" column and a long "Document Status Code (DSC)" column.
 * @param {any[]} headerRow
 * @returns {number[]}
 */
export function findDscColumnIndices(headerRow) {
  const row = headerRow || [];
  const out = [];
  row.forEach((cell, colIndex) => {
    const n = normalizeHeaderText(cell);
    if (!n) return;
    if (n === 'dsc' || (n.includes('document') && n.includes('status'))) {
      out.push(colIndex);
    }
  });
  return out;
}

/** @param {any[]} headerRow */
export function findTpcColumnIndices(headerRow) {
  const row = headerRow || [];
  const out = [];
  row.forEach((cell, colIndex) => {
    const n = normalizeHeaderText(cell);
    if (!n) return;
    if (n === 'tpc' || (n.includes('transmittal') && n.includes('purpose'))) {
      out.push(colIndex);
    }
  });
  return out;
}

function longestCellAcrossColumns(row, colIndices) {
  let best = '';
  for (const ci of colIndices) {
    const v = cellStr(row[ci]);
    if (v.length > best.length) best = v;
  }
  return best;
}

export function findFilenameSourceColumnIndices(headerRow) {
  const row = headerRow || [];
  const ordered = [];
  const seen = new Set();

  const addFor = (predicate) => {
    row.forEach((cell, colIndex) => {
      const n = normalizeHeaderText(cell);
      if (!n || seen.has(colIndex)) return;
      if (predicate(n)) {
        seen.add(colIndex);
        ordered.push(colIndex);
      }
    });
  };

  addFor((n) => n === 'filename' || n === 'file name');
  addFor((n) => n.includes('supplier') && n.includes('drawing') && n.includes('number'));
  addFor((n) => n.includes('client') && n.includes('drawing') && n.includes('number'));
  addFor((n) => n === 'drawing number' || (n.includes('drawing') && n.includes('number')));
  addFor((n) => n === 'sheet' || /^sheet\s/.test(n));
  addFor((n) => n.includes('sheet') && (n.includes('no') || n.includes('#')));
  addFor(
    (n) =>
      (n.includes('document') || n.includes('doc')) &&
      n.includes('number') &&
      !n.includes('sub') &&
      !n.includes('subtype'),
  );
  return ordered;
}

/**
 * @param {any[][]} aoa
 * @param {number} headerRow
 * @param {Map<number, string>} colMap
 * @returns {Record<string, string>[]}
 */
export function extractCanonicalRows(aoa, headerRow, colMap) {
  const fnCols = findFilenameSourceColumnIndices(aoa[headerRow]);
  const dscCols = findDscColumnIndices(aoa[headerRow]);
  const tpcCols = findTpcColumnIndices(aoa[headerRow]);
  const out = [];
  for (let r = headerRow + 1; r < aoa.length; r++) {
    const row = aoa[r];
    if (!rowHasData(row, colMap)) continue;
    /** @type {Record<string, string>} */
    const obj = {};
    for (const [col, canonical] of colMap) {
      obj[canonical] = cellStr(row[col]);
    }
    const fnFromCols = fnCols.map((ci) => cellStr(row[ci])).find(Boolean);
    if (fnFromCols) obj.filename = fnFromCols;
    const dscBest = longestCellAcrossColumns(row, dscCols);
    if (dscBest) obj.dsc = dscBest;
    const tpcBest = longestCellAcrossColumns(row, tpcCols);
    if (tpcBest) obj.tpc = tpcBest;
    out.push(obj);
  }
  return out;
}

function sheetToAOA(ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
}

/**
 * @param {import('xlsx').WorkBook} wb
 */
export function pickBestSheetForData(wb) {
  if (!wb.SheetNames?.length) {
    return { name: '', aoa: [], headerRow: 0, score: 0 };
  }
  let best = { name: '', aoa: /** @type {any[][]} */ ([]), headerRow: 0, score: -1 };
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const aoa = sheetToAOA(ws);
    const { headerRow, score } = findBestHeaderRow(aoa);
    if (score > best.score) {
      best = { name, aoa, headerRow, score };
    }
  }
  if (best.score < 0) {
    const name = wb.SheetNames[0];
    const aoa = sheetToAOA(wb.Sheets[name]);
    const { headerRow, score } = findBestHeaderRow(aoa);
    return { name, aoa, headerRow, score };
  }
  return best;
}

const DEFAULT_TEMPLATE_HEADERS = [
  'Filename',
  'Issue Status',
  'Revision',
  'Revision Date',
  'Description / Title',
  'Discipline',
  'Category',
  'Asset / ID Number',
  'Project',
  'Plant',
  'Location',
  'Department Code',
  'Document Type',
];

/** Map template header cell -> canonical (same rules as source) */
export function templateHeaderToCanonical(headerCell) {
  return headerToCanonical(headerCell);
}

/**
 * Parse vendor submittal template from a grid (same rules as parseTemplateSheet).
 * @returns {{ sheetName: string, preRows: any[][], headerRowIndex: number, headers: string[], colCanonical: (string|null)[] }}
 */
export function parseTemplateFromAoa(aoa, sheetName = '') {
  const { headerRow, score } = findBestHeaderRow(aoa);
  if (score < 2) {
    return {
      sheetName,
      preRows: [],
      headerRowIndex: 0,
      headers: [...DEFAULT_TEMPLATE_HEADERS],
      colCanonical: DEFAULT_TEMPLATE_HEADERS.map((h) => templateHeaderToCanonical(h)),
    };
  }
  const preRows = aoa.slice(0, headerRow);
  const headerCells = aoa[headerRow] || [];
  const headers = headerCells.map((c) => cellStr(c));
  const colCanonical = headers.map((h) => templateHeaderToCanonical(h));
  return { sheetName, preRows, headerRowIndex: headerRow, headers, colCanonical };
}

/**
 * Parse vendor submittal template: optional instruction row(s) then header row.
 */
export function parseTemplateSheet(ws, sheetName) {
  return parseTemplateFromAoa(sheetToAOA(ws), sheetName);
}

/**
 * @param {string} templatePath
 */
export function readTemplateLayout(templatePath) {
  const wb = XLSX.readFile(templatePath, { cellDates: true, dense: false });
  const submittalName =
    wb.SheetNames.find((n) => /submittal/i.test(n) && !/admin/i.test(n)) || wb.SheetNames[0];
  const ws = wb.Sheets[submittalName];
  return parseTemplateSheet(ws, submittalName);
}

/**
 * @param {Record<string, string>} row
 * @param {string[]} headers
 * @param {(string|null)[]} colCanonical
 */
export function canonicalRowToTemplateArray(row, headers, colCanonical) {
  return headers.map((_, i) => {
    const c = colCanonical[i];
    if (c) return row[c] ?? '';
    return '';
  });
}

// ---------------------------------------------------------------------------
// Dedupe same document across multiple source lists (latest date, then revision)
// ---------------------------------------------------------------------------

/** Excel serial date → UTC ms (approx., sufficient for comparison). */
function excelSerialToUtcMs(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n)) return null;
  const epoch = Date.UTC(1899, 11, 30);
  return epoch + Math.round(n * 86400000);
}

/**
 * @param {string | number | null | undefined} raw
 * @returns {number | null} UTC ms or null
 */
export function parseRevisionDateMs(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && !Number.isNaN(raw)) {
    if (raw > 20000 && raw < 100000) return excelSerialToUtcMs(raw);
    if (raw > 1e11) return Math.round(raw);
    return null;
  }
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    if (n >= 20000 && n < 100000) return excelSerialToUtcMs(n);
    if (n > 1e11) return Math.round(n);
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    let y = +m[3];
    if (y < 100) y += 2000;
    const us = Date.UTC(y, b - 1, a);
    const eu = Date.UTC(y, a - 1, b);
    if (!Number.isNaN(us)) return us;
    if (!Number.isNaN(eu)) return eu;
  }
  return null;
}

/**
 * Higher = newer. Handles numeric revs, letter revs (A, B, …, AA), and mixed strings.
 * @param {string | null | undefined} raw
 */
export function revisionRank(raw) {
  if (raw == null) return 0;
  let s = String(raw).trim().toUpperCase();
  if (!s) return 0;
  s = s.replace(/^R\.?\s*E\.?\s*V\.?\s*/i, '').trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (/^\d+\.\d+$/.test(s)) return Math.round(parseFloat(s) * 10000);
  if (/^[A-Z]{1,3}$/.test(s)) {
    let n = 0;
    for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n + 50000;
  }
  const mm = s.match(/\d+/);
  if (mm) return parseInt(mm[0], 10);
  return 0;
}

function rowIdentityKey(row, rowIndex) {
  const f = String(row.filename || '').trim();
  if (f) {
    const base = (f.split(/[/\\]/).pop() || f).trim();
    return 'f:' + base.replace(/\s+/g, ' ').toLowerCase();
  }
  const fallback = [row.assetId, row.project, row.description].map((x) => String(x || '').trim()).filter(Boolean).join('|');
  if (fallback) return 'nf:' + fallback.replace(/\s+/g, ' ').toLowerCase().slice(0, 200);
  return 'anon:' + rowIndex;
}

/**
 * When the same file appears in multiple uploads, keep one row: latest revision date,
 * then highest revision; if still tied, the row from the later file in the upload order wins.
 * @param {Record<string, string>[]} rows must have optional _mergeSourceIndex (0-based upload order)
 * @returns {Record<string, string>[]}
 */
export function dedupeCanonicalRowsByLatestVersion(rows) {
  /** @type {Map<string, Record<string, string>>} */
  const best = new Map();
  rows.forEach((row, rowIndex) => {
    const key = rowIdentityKey(row, rowIndex);
    const cur = best.get(key);
    if (!cur) {
      best.set(key, row);
      return;
    }
    const dc = parseRevisionDateMs(row.revisionDate);
    const di = parseRevisionDateMs(cur.revisionDate);
    if (dc != null && di != null && dc !== di) {
      if (dc > di) best.set(key, row);
      return;
    }
    if (dc != null && di == null) {
      best.set(key, row);
      return;
    }
    if (dc == null && di != null) return;
    const rc = revisionRank(row.revision);
    const ri = revisionRank(cur.revision);
    if (rc !== ri) {
      if (rc > ri) best.set(key, row);
      return;
    }
    const si = row._mergeSourceIndex ?? 0;
    const sci = cur._mergeSourceIndex ?? 0;
    if (si > sci) best.set(key, row);
  });
  return Array.from(best.values());
}

/**
 * @param {{ sheetName: string, preRows: any[][], headers: string[], rows: any[][] }} payload
 * @returns {Buffer}
 */
export function workbookBufferFromSubmittalGrid(payload) {
  const { sheetName, preRows, headers, rows } = payload;
  const width = Math.max(
    headers.length,
    ...(preRows || []).map((r) => r.length),
    ...(rows || []).map((r) => r.length),
    1,
  );
  const norm = (r) => padRow(r, width).map((c) => cellStr(c));
  const outAoa = [
    ...(preRows || []).map(norm),
    norm(headers),
    ...(rows || []).map(norm),
  ];
  const outWb = XLSX.utils.book_new();
  const outWs = XLSX.utils.aoa_to_sheet(outAoa);
  const sn = String(sheetName || '1. Submittal').slice(0, 31);
  XLSX.utils.book_append_sheet(outWb, outWs, sn);
  return XLSX.write(outWb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * @param {string[]} sourcePaths
 * @param {string | null} templatePath
 * @returns {{ sheetName: string, preRows: string[][], headers: string[], rows: string[][], summary: { files: { name: string, rows: number, sheet: string, headerRow: number }[], totalRows: number } }}
 */
export function buildSubmittalMergePayload(sourcePaths, templatePath) {
  /** @type {Record<string, string>[]} */
  let all = [];
  /** @type {{ name: string, rows: number, sheet: string, headerRow: number }[]} */
  const fileSummaries = [];

  sourcePaths.forEach((p, sourceIndex) => {
    const wb = XLSX.readFile(p, { cellDates: true, dense: false });
    const { name, aoa, headerRow, score } = pickBestSheetForData(wb);
    if (score < 2) {
      fileSummaries.push({ name: p.split(/[/\\]/).pop() || p, rows: 0, sheet: name, headerRow });
      return;
    }
    const colMap = buildColMapFromHeaderRow(aoa, headerRow);
    const rows = extractCanonicalRows(aoa, headerRow, colMap);
    for (const r of rows) {
      r._mergeSourceIndex = sourceIndex;
      all.push(r);
    }
    fileSummaries.push({
      name: p.split(/[/\\]/).pop() || p,
      rows: rows.length,
      sheet: name,
      headerRow,
    });
  });

  const rowCountBeforeDedupe = all.length;
  all = dedupeCanonicalRowsByLatestVersion(all);
  for (const r of all) {
    delete r._mergeSourceIndex;
  }
  const dedupeRemoved = rowCountBeforeDedupe - all.length;

  let layout;
  if (templatePath && templatePath.length) {
    layout = readTemplateLayout(templatePath);
  } else {
    layout = {
      sheetName: '1. Submittal',
      preRows: [
        ['*Filename MUST include the document extension*', '', '', '', '', '', '', '', '', '', '', '', ''],
      ],
      headerRowIndex: 1,
      headers: [...DEFAULT_TEMPLATE_HEADERS],
      colCanonical: DEFAULT_TEMPLATE_HEADERS.map((h) => templateHeaderToCanonical(h)),
    };
  }

  applyVendorDocumentTypes(all);
  applyVendorIssueStatuses(all);
  ensureNonBlankFilenames(all);

  const dataRows = all.map((r) => canonicalRowToTemplateArray(r, layout.headers, layout.colCanonical));

  const w = layout.headers.length;
  return {
    sheetName: layout.sheetName,
    preRows: layout.preRows.map((row) => padRow(row, w).map((c) => cellStr(c))),
    headers: layout.headers.map((h) => cellStr(h)),
    rows: dataRows.map((row) => padRow(row, w).map((c) => cellStr(c))),
    summary: {
      files: fileSummaries,
      totalRows: all.length,
      dedupe: {
        before: rowCountBeforeDedupe,
        after: all.length,
        removed: dedupeRemoved,
      },
    },
  };
}

/**
 * @param {string[]} sourcePaths
 * @param {string | null} templatePath
 * @returns {{ buffer: Buffer, summary: { files: { name: string, rows: number, sheet: string, headerRow: number }[], totalRows: number } }}
 */
export function mergeTransmittalsToSubmittal(sourcePaths, templatePath) {
  const payload = buildSubmittalMergePayload(sourcePaths, templatePath);
  const buffer = workbookBufferFromSubmittalGrid(payload);
  return {
    buffer,
    summary: payload.summary,
  };
}

function padRow(row, len) {
  const r = Array.isArray(row) ? [...row] : [];
  while (r.length < len) r.push('');
  return r.slice(0, len);
}

function sanitizeFileBase(name) {
  return String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function ensureFilenameExtension(base) {
  const s = sanitizeFileBase(base) || 'unnamed-document';
  if (/\.[a-z0-9]{2,8}$/i.test(s)) return s;
  return `${s}.pdf`;
}

/** Every row must have a non-empty Filename (adds .pdf when no extension). */
export function ensureNonBlankFilenames(rows) {
  for (const r of rows) {
    let f = String(r.filename || '').trim();
    if (f) {
      r.filename = ensureFilenameExtension(f);
      continue;
    }
    const fallbacks = [
      r.assetId,
      r.description,
      [r.project, r.vendorName, r.documentType].filter(Boolean).join('_'),
    ];
    let base = '';
    for (const x of fallbacks) {
      const t = String(x || '').trim();
      if (t) {
        base = t;
        break;
      }
    }
    r.filename = ensureFilenameExtension(base || 'unnamed-document');
  }
}

// ---------------------------------------------------------------------------
// Vendor Document Type — must be one of these (rule-based, no LLM)
// ---------------------------------------------------------------------------

/** @type {readonly string[]} */
export const VENDOR_DOCUMENT_TYPES = [
  'Conceptual Docs',
  'Correspondences',
  'Cut Sheets',
  'Drawings',
  'Listings',
  'Manuals',
  'Misc. Vendor Docs',
  'Reports',
  'Specifications',
  'Studies',
  'Submittals',
  'Transmittals',
];

const VENDOR_TYPE_BY_NORMAL = new Map(
  VENDOR_DOCUMENT_TYPES.map((t) => [normalizeHeaderText(t).replace(/\./g, ''), t]),
);

/** Multi-word phrases first (stronger signal). Values are VENDOR_DOCUMENT_TYPES labels. */
const DOC_TYPE_PHRASES = [
  ['operation and maintenance', 'Manuals'],
  ['o and m', 'Manuals'],
  ['cut sheet', 'Cut Sheets'],
  ['data sheet', 'Cut Sheets'],
  ['data-sheet', 'Cut Sheets'],
  ['product data', 'Cut Sheets'],
  ['shop drawing', 'Submittals'],
  ['material submittal', 'Submittals'],
  ['product submittal', 'Submittals'],
  ['drawing list', 'Listings'],
  ['transmittal list', 'Listings'],
  ['feasibility study', 'Studies'],
  ['basis of design', 'Conceptual Docs'],
  ['design narrative', 'Conceptual Docs'],
  ['geotech report', 'Reports'],
  ['test report', 'Reports'],
  ['inspection report', 'Reports'],
  ['specification section', 'Specifications'],
  ['project manual', 'Specifications'],
  ['misc vendor', 'Misc. Vendor Docs'],
  ['miscellaneous vendor', 'Misc. Vendor Docs'],
];

/** Keywords (normalized) → category. Longer keys checked first via sort. */
const DOC_TYPE_KEYWORD_TO_TYPE = [
  ['transmittal', 'Transmittals'],
  ['xref', 'Transmittals'],
  ['submittal', 'Submittals'],
  ['specification', 'Specifications'],
  ['specifications', 'Specifications'],
  ['masterspec', 'Specifications'],
  ['spec', 'Specifications'],
  ['drawing', 'Drawings'],
  ['elevations', 'Drawings'],
  ['elevation', 'Drawings'],
  ['sections', 'Drawings'],
  ['section', 'Drawings'], // ambiguous; lower weight via ordering after more specific
  ['details', 'Drawings'],
  ['detail', 'Drawings'],
  ['plans', 'Drawings'],
  ['plan', 'Drawings'],
  ['profile', 'Drawings'],
  ['layout', 'Drawings'],
  ['demolition', 'Drawings'],
  ['schedule', 'Listings'],
  ['register', 'Listings'],
  ['listing', 'Listings'],
  ['directory', 'Listings'],
  ['index', 'Listings'],
  ['manual', 'Manuals'],
  ['handbook', 'Manuals'],
  ['guidebook', 'Manuals'],
  ['user guide', 'Manuals'],
  ['correspondence', 'Correspondences'],
  ['correspondences', 'Correspondences'],
  ['letter', 'Correspondences'],
  ['memo', 'Correspondences'],
  ['minutes', 'Correspondences'],
  ['report', 'Reports'],
  ['summary', 'Reports'],
  ['certificate', 'Reports'],
  ['study', 'Studies'],
  ['studies', 'Studies'],
  ['feasibility', 'Studies'],
  ['analysis', 'Studies'],
  ['survey', 'Studies'],
  ['conceptual', 'Conceptual Docs'],
  ['schematic', 'Conceptual Docs'],
  ['predesign', 'Conceptual Docs'],
  ['narrative', 'Conceptual Docs'],
  ['cutsheet', 'Cut Sheets'],
  ['datasheet', 'Cut Sheets'],
  ['catalog', 'Cut Sheets'],
  ['brochure', 'Cut Sheets'],
  ['vendor', 'Misc. Vendor Docs'],
  ['misc', 'Misc. Vendor Docs'],
  ['dwg', 'Drawings'],
  ['dgn', 'Drawings'],
];

function squashForMatch(s) {
  return normalizeHeaderText(s).replace(/\./g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * If the sheet already uses a vendor label (or close), return canonical casing.
 * @param {string} raw
 * @returns {string | null}
 */
export function matchExactVendorDocumentType(raw) {
  const cell = squashForMatch(raw);
  if (!cell) return null;
  if (VENDOR_TYPE_BY_NORMAL.has(cell)) return VENDOR_TYPE_BY_NORMAL.get(cell);
  for (const v of VENDOR_DOCUMENT_TYPES) {
    const nv = squashForMatch(v);
    if (cell === nv || cell.includes(nv) || nv.includes(cell)) return v;
  }
  const singular = cell.replace(/s$/, '');
  for (const v of VENDOR_DOCUMENT_TYPES) {
    const nv = squashForMatch(v).replace(/s$/, '');
    if (singular === nv) return v;
  }
  return null;
}

/**
 * Infer vendor document type from document type, category, description, filename, etc.
 * @param {Record<string, string>} row
 * @returns {string}
 */
export function resolveVendorDocumentType(row) {
  const pieces = [
    row.documentType,
    row.category,
    row.description,
    row.filename,
    row.issueStatus,
    row.discipline,
  ]
    .map((x) => (x == null ? '' : String(x)))
    .filter(Boolean);
  const blob = squashForMatch(pieces.join(' | '));
  if (!blob) return 'Misc. Vendor Docs';

  const direct = matchExactVendorDocumentType(row.documentType || '');
  if (direct) return direct;

  /** @type {Map<string, number>} */
  const scores = new Map();
  for (const t of VENDOR_DOCUMENT_TYPES) scores.set(t, 0);

  const lowerBlob = blob;
  const padded = ` ${lowerBlob} `;

  for (const [phrase, type] of DOC_TYPE_PHRASES) {
    if (lowerBlob.includes(phrase)) scores.set(type, (scores.get(type) || 0) + 6);
  }

  // MasterFormat–style references (e.g. 03 30 00, 3-30-00) → Specifications
  const joined = pieces.join(' ');
  if (/\b\d{1,2}[\s\-]\d{2}[\s\-]\d{2,4}\b/.test(joined)) {
    scores.set('Specifications', (scores.get('Specifications') || 0) + 8);
  }
  if (/\bdiv(ision)?\.?\s*\d{1,2}\b/i.test(pieces.join(' '))) {
    scores.set('Specifications', (scores.get('Specifications') || 0) + 3);
  }

  const sortedKw = [...DOC_TYPE_KEYWORD_TO_TYPE].sort((a, b) => b[0].length - a[0].length);
  for (const [kw, type] of sortedKw) {
    if (padded.includes(` ${kw} `) || padded.includes(` ${kw}s `)) {
      scores.set(type, (scores.get(type) || 0) + 3);
    }
  }

  const fn = squashForMatch(row.filename || '');
  if (/\.(dwg|dgn|dxf)$/i.test(fn)) scores.set('Drawings', (scores.get('Drawings') || 0) + 5);
  if (/transmittal/i.test(fn)) scores.set('Transmittals', (scores.get('Transmittals') || 0) + 4);
  if (/drawing\s*list|sheet\s*list|doc(ument)?\s*list/i.test(fn + ' ' + lowerBlob)) {
    scores.set('Listings', (scores.get('Listings') || 0) + 2);
  }

  // Prefer explicit "drawing" / "sheet" in description for AEC rows (drawing lists)
  if (/\b(sheet|dwg|plan|section|detail|elevation|ga|g\.a\.)\b/i.test(row.description || '')) {
    scores.set('Drawings', (scores.get('Drawings') || 0) + 2);
  }

  let best = 'Misc. Vendor Docs';
  let bestScore = scores.get('Misc. Vendor Docs') || 0;
  for (const t of VENDOR_DOCUMENT_TYPES) {
    if (t === 'Misc. Vendor Docs') continue;
    const sc = scores.get(t) || 0;
    if (sc > bestScore) {
      bestScore = sc;
      best = t;
    }
  }

  if (bestScore < 2) {
    const fromAny = matchExactVendorDocumentType(pieces.join(' '));
    if (fromAny) return fromAny;
    return 'Misc. Vendor Docs';
  }

  return best;
}

/**
 * @param {Record<string, string>[]} rows
 */
export function applyVendorDocumentTypes(rows) {
  for (const r of rows) {
    r.documentType = resolveVendorDocumentType(r);
  }
}

// ---------------------------------------------------------------------------
// Vendor Issue Status — must be one of these (rule-based, no LLM)
// ---------------------------------------------------------------------------

/** @type {readonly string[]} */
export const VENDOR_ISSUE_STATUSES = [
  'AB- As-Built',
  'APR- Approved',
  'BID- For Bid Use only',
  'CRT- Certified',
  'FYU- For Your Use',
  'IFA- Issued For Approval',
  'IFC- Issued For Construction',
  'IFR- Issued For Review and Comments',
  'PRE- Preliminary',
  'REC- For Records',
  'RFE- Released for Engr',
  'RWC- Returned with Comments',
];

/** Lowercase code → exact vendor label */
const ISSUE_CODE_TO_VENDOR = new Map(
  [
    ['ab', 'AB- As-Built'],
    ['apr', 'APR- Approved'],
    ['bid', 'BID- For Bid Use only'],
    ['crt', 'CRT- Certified'],
    ['fyu', 'FYU- For Your Use'],
    ['ifa', 'IFA- Issued For Approval'],
    ['ifc', 'IFC- Issued For Construction'],
    ['ifr', 'IFR- Issued For Review and Comments'],
    ['pre', 'PRE- Preliminary'],
    ['rec', 'REC- For Records'],
    ['rfe', 'RFE- Released for Engr'],
    ['rwc', 'RWC- Returned with Comments'],
  ],
);

/** Longer / more specific phrases first. Value = VENDOR_ISSUE_STATUSES entry. */
const ISSUE_PHRASES = [
  ['issued for construction', 'IFC- Issued For Construction'],
  ['issued for approval', 'IFA- Issued For Approval'],
  ['issued for review and comments', 'IFR- Issued For Review and Comments'],
  ['issued for review', 'IFR- Issued For Review and Comments'],
  ['for review and comments', 'IFR- Issued For Review and Comments'],
  ['for review and comment', 'IFR- Issued For Review and Comments'],
  ['returned with comments', 'RWC- Returned with Comments'],
  ['released for engineering', 'RFE- Released for Engr'],
  ['released for engr', 'RFE- Released for Engr'],
  ['for bid use only', 'BID- For Bid Use only'],
  ['for bid use', 'BID- For Bid Use only'],
  ['for your use', 'FYU- For Your Use'],
  ['for records', 'REC- For Records'],
  ['as-built', 'AB- As-Built'],
  ['as built', 'AB- As-Built'],
];

/** Shorter keywords (padded word match). Value = vendor label. */
const ISSUE_KEYWORDS = [
  ['preliminary', 'PRE- Preliminary'],
  ['prelim', 'PRE- Preliminary'],
  ['certified', 'CRT- Certified'],
  ['approved', 'APR- Approved'],
];

/** 3- and 2-letter codes; longer first for IFA/IFC/IFR. */
const ISSUE_CODE_TOKENS = ['ifa', 'ifc', 'ifr', 'apr', 'ab', 'bid', 'crt', 'fyu', 'pre', 'rec', 'rfe', 'rwc'];

function extractIssueCodeToken(text) {
  const s = squashForMatch(text);
  if (!s) return null;
  const padded = ` ${s} `;
  for (const c of ISSUE_CODE_TOKENS) {
    if (padded.includes(` ${c} `)) return c;
  }
  const m = s.match(
    /^(ab|apr|bid|crt|fyu|ifa|ifc|ifr|pre|rec|rfe|rwc)(?:\s*[-–.]\s*|\s+|$)/i,
  );
  if (m) return m[1].toLowerCase();
  return null;
}

/** Drawing-list / transmittal status text (often ALL CAPS) → vendor Issue Status label. */
const BUZZI_STATUS_UPPER = new Map([
  ['PRELIMINARY', 'PRE- Preliminary'],
  ['PRELIM', 'PRE- Preliminary'],
  ['REFERENCE', 'REC- For Records'],
  ['REF', 'REC- For Records'],
  ['IN PROGRESS', 'PRE- Preliminary'],
  ['INFORMATION', 'FYU- For Your Use'],
  ['INFORMATION ONLY', 'FYU- For Your Use'],
  ['FOR INFORMATION', 'FYU- For Your Use'],
  ['FOR INFORMATION ONLY', 'FYU- For Your Use'],
  ['AS-BUILT', 'AB- As-Built'],
  ['AS BUILT', 'AB- As-Built'],
  ['CERTIFIED', 'CRT- Certified'],
  ['APPROVED', 'APR- Approved'],
  ['IFC', 'IFC- Issued For Construction'],
  ['IFA', 'IFA- Issued For Approval'],
  ['IFR', 'IFR- Issued For Review and Comments'],
  ['IFB', 'BID- For Bid Use only'],
  ['FYU', 'FYU- For Your Use'],
  ['AB', 'AB- As-Built'],
  ['APR', 'APR- Approved'],
  ['BID', 'BID- For Bid Use only'],
  ['CRT', 'CRT- Certified'],
  ['PRE', 'PRE- Preliminary'],
  ['REC', 'REC- For Records'],
  ['RFE', 'RFE- Released for Engr'],
  ['RWC', 'RWC- Returned with Comments'],
]);

function mapBuzziAbbrevIssueStatus(row) {
  const raw = [row.issueStatus, row.dsc, row.tpc]
    .filter((x) => x != null && String(x).trim() !== '')
    .map((x) => String(x).trim());
  for (const p of raw) {
    const u = p.toUpperCase().replace(/\s+/g, ' ').trim();
    if (BUZZI_STATUS_UPPER.has(u)) return BUZZI_STATUS_UPPER.get(u);
    const code = extractIssueCodeToken(p);
    if (code && ISSUE_CODE_TO_VENDOR.has(code)) return ISSUE_CODE_TO_VENDOR.get(code);
  }
  return null;
}

/**
 * @param {string} raw
 * @returns {string | null}
 */
export function matchExactVendorIssueStatus(raw) {
  if (raw == null) return null;
  const str = String(raw).trim();
  if (!str) return null;
  const cell = squashForMatch(str);
  for (const v of VENDOR_ISSUE_STATUSES) {
    if (squashForMatch(v) === cell) return v;
  }
  for (const v of VENDOR_ISSUE_STATUSES) {
    const sv = squashForMatch(v);
    if (cell.startsWith(sv) || sv.startsWith(cell)) return v;
  }
  const code = extractIssueCodeToken(str);
  if (code && ISSUE_CODE_TO_VENDOR.has(code)) return ISSUE_CODE_TO_VENDOR.get(code);
  return null;
}

/**
 * @param {Record<string, string>} row
 * @returns {string} vendor label or '' if unknown
 */
export function resolveVendorIssueStatus(row) {
  const buzzi = mapBuzziAbbrevIssueStatus(row);
  if (buzzi) return buzzi;

  const primary = row.issueStatus == null ? '' : String(row.issueStatus).trim();
  const direct = matchExactVendorIssueStatus(primary);
  if (direct) return direct;

  const pieces = [primary, row.dsc, row.tpc, row.description, row.revision]
    .map((x) => (x == null ? '' : String(x)))
    .filter(Boolean);
  const blob = squashForMatch(pieces.join(' | '));
  if (!blob) return 'FYU- For Your Use';

  const code = extractIssueCodeToken(blob);
  if (code && ISSUE_CODE_TO_VENDOR.has(code)) return ISSUE_CODE_TO_VENDOR.get(code);

  /** @type {Map<string, number>} */
  const scores = new Map();
  for (const v of VENDOR_ISSUE_STATUSES) scores.set(v, 0);

  for (const [phrase, label] of ISSUE_PHRASES) {
    if (blob.includes(phrase)) scores.set(label, (scores.get(label) || 0) + 8);
  }

  const padded = ` ${blob} `;
  for (const [kw, label] of ISSUE_KEYWORDS) {
    if (padded.includes(` ${kw} `)) scores.set(label, (scores.get(label) || 0) + 4);
  }

  let best = '';
  let bestScore = 0;
  for (const v of VENDOR_ISSUE_STATUSES) {
    const sc = scores.get(v) || 0;
    if (sc > bestScore) {
      bestScore = sc;
      best = v;
    }
  }

  if (bestScore >= 4) return best;

  const fuzzy = matchExactVendorIssueStatus(pieces.join(' '));
  return fuzzy || 'FYU- For Your Use';
}

/**
 * @param {Record<string, string>[]} rows
 */
export function applyVendorIssueStatuses(rows) {
  for (const r of rows) {
    r.issueStatus = resolveVendorIssueStatus(r);
  }
}
