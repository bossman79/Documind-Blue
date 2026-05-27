import XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import {
  pickBestSheetForData,
  buildColMapFromHeaderRow,
  extractCanonicalRows,
  headerToCanonical
} from './submittalImport.js';

// Configuration
const W_FILENAME_PREFIX = 30;
const W_FILENAME_TOKEN = 20;
const W_TITLE_TOKEN = 18;
const W_VENDOR = 15;
const W_PLANT = 10;
const W_PROJECT = 10;
const W_DISCIPLINE = 8;
const W_DOCTYPE = 8;
const W_ASSET = 22;                 // explicit asset/part-ID column match (was 12)
const W_ASSET_EXACT_BONUS = 13;     // identical asset adds this on top of W_ASSET
const W_ASSET_FNAME = 14;           // asset/part-ID extracted from filename/description
const W_DEPT_CODE = 6;
const W_DEPT_NAME = 5;
const W_CATEGORY = 4;
const W_DATE_YEAR = 3;
const W_REVISION_SER = 8;

// Minimum score for a pair to even be considered (lowest tier — "borderline / review only")
const MIN_SCORE = 35;
// Strong-match threshold: pairs at or above this score participate in clustering (groups view)
const STRONG_SCORE = 75;
// Score that overrides the "min reasons" rule (a single, exceptionally strong signal is enough)
const OVERRIDE_SCORE = 95;
// Minimum number of independent matching reasons required for a strong link (unless OVERRIDE_SCORE is met)
const MIN_REASONS_FOR_STRONG = 2;

const NOISE_WORDS = new Set([
  "THE", "AND", "FOR", "OF", "IN", "AT", "TO", "BY",
  "A", "AN", "WITH", "FROM", "ON", "OR", "IS", "AS",
  "BE", "IT", "THIS", "THAT", "ARE", "WAS", "REV",
  "REVISION", "SHEET", "PDF", "DWG", "DOC", "FILE",
  "NO", "NR", "N", "R", "ID", "REF", "SEE", "PER",
  "ALL", "NEW", "OLD", "MISC", "GEN", "GENERAL",
  "DETAILS", "DETAIL", "DRAWING", "DRAWINGS", "DWG",
  "PAGE", "PAGES", "PLAN", "PLANS", "VIEW", "VIEWS",
  "00", "01", "0", "1"
]);

function shouldSkipToken(t, keepShortNums) {
  if (NOISE_WORDS.has(t)) return true;
  if (!keepShortNums) {
    if (t.length <= 2 && /^\d+$/.test(t)) return true;
  }
  if (t.length === 1 && /^[A-Z]$/.test(t)) return true;
  return false;
}

function tokenise(s, keepShortNums = false) {
  if (!s) return new Set();
  let upper = String(s).toUpperCase().trim();
  
  // strip extension
  const lastDot = upper.lastIndexOf('.');
  if (lastDot > 0) {
    const ext = upper.slice(lastDot + 1);
    if (ext.length <= 4) {
      upper = upper.slice(0, lastDot);
    }
  }

  const tokens = new Set();
  let buf = "";
  for (let i = 0; i < upper.length; i++) {
    const ch = upper[i];
    if (/[A-Z0-9]/.test(ch)) {
      buf += ch;
    } else {
      if (buf.length > 0) {
        if (!shouldSkipToken(buf, keepShortNums)) tokens.add(buf);
        buf = "";
      }
    }
  }
  if (buf.length > 0) {
    if (!shouldSkipToken(buf, keepShortNums)) tokens.add(buf);
  }
  return tokens;
}

function jaccardSim(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const k of setA) {
    if (setB.has(k)) inter++;
  }
  const uni = setA.size + setB.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

function normalVendor(v) {
  if (!v) return "";
  let u = String(v).toUpperCase().trim();
  if (u.includes("QUALICO")) return "QUALICO STEEL";
  if (u.includes("TOSHIBA")) return "TOSHIBA";
  if (u.includes("EATON")) return "EATON";
  if (u.includes("MACDONALD ENG") || u.includes("MCDONALD ENG")) return "MACDONALD ENGINEERING";
  if (u.includes("ROCKWELL")) return "ROCKWELL AUTOMATION";
  if (u.includes("ATLAS COPCO")) return "ATLAS COPCO";
  if (u.includes("REDECAM")) return "REDECAM";
  if (u.includes("LVTA") || u.includes("LEHIGH VALLEY TECH") || u.includes("LAYVA ENGINEERING")) return "LVTA ENGINEERING";
  if (u.includes("FLSMIDTH")) return "FLSMIDTH";
  if (u.includes("THYSSENKRUPP")) return "THYSSENKRUPP INDUSTRIAL";
  if (u.includes("TRANSCO") || u.includes("TRANSOCO")) return "TRANSCO NORTHWEST";
  if (u.includes("ELLIS CONSTRUCTION")) return "ELLIS CONSTRUCTION";
  if (u.startsWith("ABB")) return "ABB";
  if (u.includes("REINFORCED EARTH")) return "REINFORCED EARTH CO";
  if (u.includes("ZACHRY")) return "ZACHRY ENGINEERING";
  if (u.includes("CAMBRIA") || (u.startsWith("CAB") && u.length < 10)) return "CAB";
  return u;
}

function filenamePrefix(fn) {
  if (!fn) return "";
  let upper = String(fn).toUpperCase().trim();
  const lastDot = upper.lastIndexOf('.');
  if (lastDot > 0) upper = upper.slice(0, lastDot);
  
  let candidate = upper.split(" ")[0].trim();
  candidate = candidate.split("_")[0].trim();
  candidate = candidate.split("-")[0].trim(); // Also splitting on dash here as in original code logic intent
  if (candidate.length > 12) candidate = candidate.slice(0, 12);
  return candidate;
}

function revisionsSequential(r1, r2) {
  if (!r1 || !r2) return false;
  let tr1 = String(r1).trim().toUpperCase().replace(/^R\.?\s*E\.?\s*V\.?\s*/i, '').trim();
  let tr2 = String(r2).trim().toUpperCase().replace(/^R\.?\s*E\.?\s*V\.?\s*/i, '').trim();
  if (!tr1 || !tr2) return false;

  if (/^\d+$/.test(tr1) && /^\d+$/.test(tr2)) {
    return Math.abs(parseInt(tr1, 10) - parseInt(tr2, 10)) <= 2;
  }
  if (tr1.length === 1 && /[A-Z]/.test(tr1) && tr2.length === 1 && /[A-Z]/.test(tr2)) {
    return Math.abs(tr1.charCodeAt(0) - tr2.charCodeAt(0)) <= 2;
  }
  return false;
}

function extractYear(d) {
  if (!d) return "";
  let s = String(d).trim();
  if (!s) return "";
  
  const parts = s.split("/");
  if (parts.length >= 2) {
    let yr = parts[parts.length - 1].trim();
    if (yr.length === 2) yr = "20" + yr;
    if (yr.length === 4 && !isNaN(parseInt(yr))) return yr;
  }
  
  for (let i = 0; i <= s.length - 4; i++) {
    const sub4 = s.slice(i, i + 4);
    if (/^\d{4}$/.test(sub4)) {
      const y = parseInt(sub4, 10);
      if (y >= 1950 && y <= 2030) return sub4;
    }
  }
  return "";
}

/**
 * Extract plausible asset/part-ID patterns from a free-text string (filename
 * or description). Catches things like P-101, MCC-1234, AB1234C, T-7050A, 12345AB.
 * Returns a Set of normalized IDs (separators stripped, upper-cased).
 *
 * We are deliberately conservative — we require either:
 *   - letter prefix + digits  (e.g. P101, MCC1234, AB7050A)
 *   - or a numeric ID of length >= 4 followed by letters (e.g. 1234A, 7050AB)
 * Pure 3-digit numbers (like "001") are too noisy to count as IDs.
 */
function extractAssetIds(text) {
  if (!text) return new Set();
  const upper = String(text).toUpperCase();
  const ids = new Set();

  // Strip extension for filenames so it doesn't get picked up
  let body = upper;
  const dot = body.lastIndexOf(".");
  if (dot > 0 && body.length - dot <= 5) body = body.slice(0, dot);

  // letter(s) + optional separator + digits + optional trailing alphanumerics
  const reAlphaNum = /[A-Z]{1,5}[-_]?\d{2,}[A-Z0-9]{0,4}/g;
  let m;
  while ((m = reAlphaNum.exec(body)) !== null) {
    const norm = m[0].replace(/[-_]/g, "");
    if (norm.length >= 3 && norm.length <= 20) ids.add(norm);
  }

  // Pure numeric only if 4+ digits AND the surrounding text isn't a year-like
  const reNum = /(?<![A-Z0-9])(\d{4,7})(?![A-Z0-9])/g;
  while ((m = reNum.exec(body)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1950 && n <= 2099 && m[1].length === 4) continue; // looks like a year
    ids.add(m[1]);
  }

  return ids;
}

/** Best (longest) shared asset/part-ID between two doc sets, or null. */
function sharedAssetId(a, b) {
  if (!a || !b || !a.size || !b.size) return null;
  let best = null;
  for (const x of a) {
    if (b.has(x) && (!best || x.length > best.length)) best = x;
  }
  return best;
}

/**
 * Extract a revision token from the END of a filename. Handles common
 * conventions: -REV4, _REV.B, .REVA, -R3, REVISION 02.
 *
 * Intentionally conservative — we ONLY match when an explicit "REV" prefix
 * or "R" + digit is present, never a bare trailing letter like "-A" which
 * is ambiguous (could be a part designator).
 *
 * Returns the upper-cased revision token (e.g. "4", "A", "B", "02"), or "".
 */
function extractFilenameRevision(filename) {
  if (!filename) return "";
  let s = String(filename).toUpperCase();
  const dot = s.lastIndexOf(".");
  if (dot > 0) s = s.slice(0, dot);
  s = s.trim();

  // Try strongest pattern first (explicit "REV"), then "R<digit>"
  let m = s.match(/[\s_\-\.\(]+REV(?:ISION)?\.?\s*([A-Z0-9]{1,4})$/i);
  if (m) return m[1].toUpperCase();

  m = s.match(/[\s_\-\.\(]+R(\d{1,3})$/i);
  if (m) return m[1].toUpperCase();

  return "";
}

/**
 * Returns true if two revision tokens represent the same revision after
 * normalisation. Handles "4" vs "04", "A" vs "a", "rev 4" vs "4".
 */
function revisionsEqual(a, b) {
  if (a == null || b == null) return false;
  const norm = (v) => String(v)
    .trim().toUpperCase()
    .replace(/^R\.?\s*E\.?\s*V\.?\s*I?\s*S?\s*I?\s*O?\s*N?\s*/i, "")
    .replace(/^0+(?=\d)/, "")
    .trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  return na === nb;
}

function computePairScore(d1, d2) {
  let score = 0;

  // 1. FILENAME PREFIX
  const pfx1 = d1.prefix;
  const pfx2 = d2.prefix;
  if (pfx1.length >= 4 && pfx2.length >= 4) {
    if (pfx1 === pfx2) {
      score += W_FILENAME_PREFIX;
    } else if (pfx1.slice(0, 5) === pfx2.slice(0, 5)) {
      score += W_FILENAME_PREFIX * 0.6;
    }
  }

  // 2. FILENAME TOKEN JACCARD
  score += jaccardSim(d1.fnTokens, d2.fnTokens) * W_FILENAME_TOKEN;

  // 3. TITLE / DESCRIPTION TOKEN JACCARD
  if (d1.title.length > 3 && d2.title.length > 3) {
    const tj = jaccardSim(d1.titleTokens, d2.titleTokens);
    score += tj * W_TITLE_TOKEN;
    if (tj > 0.7) score += 5;
  }

  // 4. VENDOR
  if (d1.vendor && d1.vendor === d2.vendor) score += W_VENDOR;

  // 5. PLANT
  if (d1.plant && d1.plant === d2.plant) score += W_PLANT;

  // 6. PROJECT
  if (d1.project && d1.project === d2.project) score += W_PROJECT;

  // 7. DISCIPLINE
  if (d1.discipline && d1.discipline === d2.discipline) score += W_DISCIPLINE;

  // 8. DOCUMENT TYPE
  if (d1.dtype && d1.dtype === d2.dtype) score += W_DOCTYPE;

  // 9. ASSET / ID NUMBER  (explicit asset-column match)
  let assetColumnMatched = false;
  if (d1.asset.length > 2 && d2.asset.length > 2) {
    if (d1.asset === d2.asset) {
      score += W_ASSET + W_ASSET_EXACT_BONUS;
      // High-specificity bonus: long alphanumeric IDs are unlikely to collide
      if (d1.asset.length >= 5 && /[A-Z]/.test(d1.asset) && /\d/.test(d1.asset)) score += 5;
      assetColumnMatched = true;
    } else {
      const j = jaccardSim(d1.assetTokens, d2.assetTokens);
      score += j * W_ASSET;
      if (j >= 0.5) assetColumnMatched = true;
    }
  }

  // 9b. Asset/part-ID extracted from filename or description (fallback / supplement).
  // Only counts if the explicit column did NOT already establish the match.
  if (!assetColumnMatched) {
    const all1 = new Set([...(d1.fnAssetIds || []), ...(d1.titleAssetIds || [])]);
    const all2 = new Set([...(d2.fnAssetIds || []), ...(d2.titleAssetIds || [])]);
    const sharedId = sharedAssetId(all1, all2);
    if (sharedId) {
      // Specificity ladder by length (more characters → less likely to be coincidental)
      let w = W_ASSET_FNAME * 0.55;          // 3-4 chars: weak
      if (sharedId.length >= 5) w = W_ASSET_FNAME * 0.85;
      if (sharedId.length >= 6) w = W_ASSET_FNAME;
      if (sharedId.length >= 8) w = W_ASSET_FNAME + 4;
      score += w;
    }
  }

  // 10. DEPARTMENT CODE
  if (d1.deptCode && d1.deptCode === d2.deptCode) score += W_DEPT_CODE;

  // 11. DEPARTMENT NAME
  if (d1.deptName && d1.deptName === d2.deptName) score += W_DEPT_NAME;

  // 12. CATEGORY
  if (d1.category && d1.category === d2.category) score += W_CATEGORY;

  // 13. DATE YEAR
  if (d1.year && d1.year === d2.year) score += W_DATE_YEAR;

  // 14. REVISION SERIES
  if (revisionsSequential(d1.revision, d2.revision)) score += W_REVISION_SER;

  return score;
}

function relationshipReasons(d1, d2, score) {
  const reasons = [];

  const pfx1 = d1.prefix;
  const pfx2 = d2.prefix;
  if (pfx1.length >= 4 && pfx2.length >= 4 && pfx1 === pfx2) {
    reasons.push(`Same file prefix (${pfx1})`);
  }

  if (jaccardSim(d1.fnTokens, d2.fnTokens) >= 0.35) {
    reasons.push("Similar filename tokens");
  }

  if (d1.title.length > 3 && d2.title.length > 3) {
    const tj = jaccardSim(d1.titleTokens, d2.titleTokens);
    if (tj >= 0.5) {
      reasons.push(tj >= 0.8 ? "Nearly identical description" : "Very similar description");
    } else if (tj >= 0.25) {
      reasons.push("Overlapping description keywords");
    }
  }

  if (d1.vendor && d1.vendor === d2.vendor) reasons.push(`Same vendor: ${d1.vendor}`);
  if (d1.plant && d1.plant === d2.plant) reasons.push(`Same plant: ${d1.plant}`);
  if (d1.project && d1.project === d2.project) reasons.push(`Same project: ${d1.project}`);
  if (d1.discipline && d1.discipline === d2.discipline) reasons.push(`Same discipline: ${d1.discipline}`);
  if (d1.dtype && d1.dtype === d2.dtype) reasons.push(`Same doc type: ${d1.dtype}`);

  let assetReasonPushed = false;
  if (d1.asset.length > 2 && d2.asset.length > 2) {
    if (d1.asset === d2.asset) {
      reasons.push(`Matching asset/part ID: ${d1.assetRaw}`);
      assetReasonPushed = true;
    } else if (jaccardSim(d1.assetTokens, d2.assetTokens) >= 0.4) {
      reasons.push("Overlapping asset/ID numbers");
      assetReasonPushed = true;
    }
  }
  // Filename / description asset ID fallback
  if (!assetReasonPushed) {
    const all1 = new Set([...(d1.fnAssetIds || []), ...(d1.titleAssetIds || [])]);
    const all2 = new Set([...(d2.fnAssetIds || []), ...(d2.titleAssetIds || [])]);
    const sharedId = sharedAssetId(all1, all2);
    if (sharedId && sharedId.length >= 4) {
      reasons.push(`Shared asset/part ID: ${sharedId}`);
    }
  }

  if (d1.deptCode && d1.deptCode === d2.deptCode) reasons.push(`Same dept code: ${d1.deptCode}`);

  if (revisionsSequential(d1.revision, d2.revision)) {
    reasons.push(`Sequential revisions (${d1.revision}→${d2.revision})`);
  }

  if (d1.year && d1.year === d2.year) reasons.push(`Same revision year: ${d1.year}`);

  return reasons;
}

function relationshipLabel(d1, d2, score) {
  const reasons = relationshipReasons(d1, d2, score);
  if (reasons.length === 0) {
    return `Multiple weak shared signals (score: ${Math.round(score)})`;
  }
  return reasons.join(" | ");
}

/**
 * Intrinsic, context-free parent score. Used as a small bias only — the
 * authoritative selection happens per-cluster in `chooseClusterParent`.
 */
function getDocParentScore(d) {
  let score = 0;

  const fn = (d.filename || "").toUpperCase();
  let ext = "";
  const pos = fn.lastIndexOf(".");
  if (pos > 0) ext = fn.slice(pos + 1);

  // Light extension bias — drawings tend to be parents, spreadsheets tend to
  // be children — but nowhere near strong enough to override structural signals.
  if (ext === "DWG") score += 6;
  if (ext === "PDF") score += 4;
  if (["XLSX", "XLSM", "XLS", "CSV"].includes(ext)) score -= 4;
  if (["DOC", "DOCX"].includes(ext)) score -= 2;

  const title = d.title || "";
  const PARENT_WORDS = [
    "ASSEMBLY", "ASSY", "LAYOUT",
    "OVERVIEW", "SYSTEM", "MAIN", "INDEX"
  ];
  const CHILD_WORDS = [
    "DETAIL", "PART", "COMPONENT", "SECTION", "LIST", "BOM",
    "BILL OF MATERIAL", "SCHEDULE", "I/O", "I O LIST", "IO LIST",
    "DATASHEET", "DATA SHEET", "SPEC", "SPECIFICATION"
  ];
  for (const w of PARENT_WORDS) if (title.includes(w)) score += 8;
  for (const w of CHILD_WORDS)  if (title.includes(w)) score -= 8;

  const dt = d.dtype || "";
  if (dt.includes("DRAWING") || dt.includes("PLAN") || dt.includes("ASSEMBLY")) score += 6;
  if (dt.includes("BOM") || dt.includes("LIST") || dt.includes("SCHEDULE") ||
      dt.includes("DATASHEET")) score -= 6;

  return score;
}

/**
 * Tokens that, when present at the end of a filename stem, strongly suggest
 * the file is a child of a base parent. Matched as standalone segments.
 */
const CHILD_SUFFIX_TOKENS = new Set([
  "DETAIL", "DETAILS", "BOM", "IO", "PART", "PARTS", "COMPONENT", "COMPONENTS",
  "SECTION", "SECTIONS", "LIST", "SCHEDULE", "DATASHEET", "SPEC", "SPECS",
  "SPECIFICATION", "BILLOFMATERIAL", "BILLOFMATERIALS"
]);

/** Strip extension + trailing revision tokens + trailing child-suffix tokens. */
function coreStem(filename) {
  if (!filename) return "";
  let s = String(filename).toUpperCase().trim();
  const dot = s.lastIndexOf(".");
  if (dot > 0) s = s.slice(0, dot);

  // Strip trailing revision patterns like  -REVA, _REV01, -R3, REV.B
  const revTail = /[\s_\-\.]+(?:REV\.?\s*[A-Z0-9]+|R\d+|REV)$/i;
  let prev;
  do { prev = s; s = s.replace(revTail, ""); } while (s !== prev);

  // Strip trailing child-suffix tokens (one or more, e.g. "-BOM-LIST")
  const splitRe = /[\s_\-\.]+/;
  let parts = s.split(splitRe);
  while (parts.length > 1) {
    const tail = parts[parts.length - 1];
    if (CHILD_SUFFIX_TOKENS.has(tail) || /^REV[A-Z0-9]*$/.test(tail) || /^R\d+$/.test(tail)) {
      parts.pop();
    } else {
      break;
    }
  }
  return parts.join("-");
}

/** Numerical-ish comparable revision value: lower = earlier / more "origin". */
function revisionOrdinal(rev) {
  if (rev == null || rev === "") return 0; // blank == origin
  const s = String(rev).trim().toUpperCase().replace(/^R\.?\s*E\.?\s*V\.?\s*/i, "").trim();
  if (s === "") return 0;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (/^[A-Z]$/.test(s)) return s.charCodeAt(0) - 64; // A=1, B=2, ...
  // Anything else — push to the back so it's never picked as "origin"
  return 9999;
}

/** Does `child` look like an extension of `parent` (e.g. ABC-100 → ABC-100-BOM)? */
function isStemExtension(parentStem, childFilename) {
  if (!parentStem || parentStem.length < 4) return false;
  const c = String(childFilename || "").toUpperCase();
  if (!c.startsWith(parentStem)) return false;
  // Require a separator (or extension dot) right after the parent stem
  const next = c.charAt(parentStem.length);
  return next === "-" || next === "_" || next === " " || next === "." || next === "";
}

/**
 * Pick the best parent for a cluster using structural evidence. Returns
 * { doc, reasons[] } so the UI can explain the choice.
 */
function chooseClusterParent(clusterDocs, pairPool) {
  // Count strong-pair degree per doc (the "hub" of the cluster is often the parent)
  const degree = new Map();
  for (const p of pairPool) {
    if (!clusterDocs.some(d => d.index === p.i)) continue;
    if (!clusterDocs.some(d => d.index === p.j)) continue;
    degree.set(p.i, (degree.get(p.i) || 0) + 1);
    degree.set(p.j, (degree.get(p.j) || 0) + 1);
  }

  // Filename length stats for "shortest filename" bonus
  const lens = clusterDocs.map(d => (d.filename || "").length);
  const minLen = Math.min(...lens);

  // Revision ordinals — lowest = "origin"
  const revOrds = clusterDocs.map(d => revisionOrdinal(d.revision));
  const minRev  = Math.min(...revOrds);

  let best = null;
  // Is there a GA in this cluster at all? If so, non-GA docs get demoted —
  // a GA is the canonical parent.
  const clusterHasGA = clusterDocs.some(isGeneralArrangement);

  for (const d of clusterDocs) {
    const reasons = [];
    let s = d.parentScore; // intrinsic base

    // ---- General Arrangement detection (industry-strongest parent signal) ----
    const isGA = isGeneralArrangement(d);
    if (isGA) {
      s += 40;
      reasons.push("General Arrangement (GA) drawing");
    } else if (clusterHasGA) {
      // There's a GA in the cluster but this isn't it — penalize so the GA wins
      s -= 25;
    }

    // Filename stem containment — by far the strongest signal.
    // Count how many OTHER docs in the cluster look like extensions of THIS doc.
    const stem = coreStem(d.filename);
    let containedCount = 0;
    if (stem.length >= 4) {
      for (const other of clusterDocs) {
        if (other.index === d.index) continue;
        if (isStemExtension(stem, other.filename)) containedCount++;
      }
    }
    if (containedCount > 0) {
      s += 25 * containedCount;
      reasons.push(`${containedCount} other doc${containedCount === 1 ? "" : "s"} extend filename "${stem}"`);
    }

    // Penalize if THIS doc looks like a child of any other doc in the cluster
    let extendsCount = 0;
    for (const other of clusterDocs) {
      if (other.index === d.index) continue;
      const otherStem = coreStem(other.filename);
      if (otherStem.length >= 4 && isStemExtension(otherStem, d.filename)) extendsCount++;
    }
    if (extendsCount > 0) {
      s -= 30 * extendsCount;
      // Don't claim "parent reason" for negative signals
    }

    // Lowest revision in cluster — origin bias
    const myRev = revisionOrdinal(d.revision);
    if (myRev === minRev && minRev !== Math.max(...revOrds)) {
      s += 12;
      const label = d.revision == null || d.revision === "" ? "(blank)" : String(d.revision);
      reasons.push(`Earliest revision in group ${label}`);
    }

    // Shortest filename in cluster — parents tend to be base names
    if ((d.filename || "").length === minLen) {
      s += 8;
      reasons.push("Shortest filename in group");
    }

    // Has child-suffix tokens itself → not a parent
    const myParts = String(d.filename || "").toUpperCase().split(/[\s_\-\.]+/);
    if (myParts.some(t => CHILD_SUFFIX_TOKENS.has(t))) {
      s -= 18;
    }

    // Hub bias: more connections inside the cluster
    const deg = degree.get(d.index) || 0;
    if (deg >= 2) {
      s += 4 * deg;
      reasons.push(`Linked to ${deg} other doc${deg === 1 ? "" : "s"} in group`);
    }

    if (!best || s > best.score) best = { doc: d, score: s, reasons };
  }

  if (!best) best = { doc: clusterDocs[0], score: 0, reasons: [] };
  // If we ended up with no positive reasons, drop a generic fallback line
  if (best.reasons.length === 0) {
    best.reasons.push("Highest intrinsic parent score (no structural signals)");
  }
  return best;
}

/**
 * Detect "General Arrangement" / "GA" markers in title, filename, or doc type.
 * GA drawings are by industry convention the canonical parent document, so we
 * give them a substantial bonus during cluster parent selection.
 */
function isGeneralArrangement(d) {
  const title = (d.title || "").toUpperCase();
  const fn    = (d.filename || "").toUpperCase();
  const dt    = (d.dtype || "").toUpperCase();
  const haystack = `${title} ${fn} ${dt}`;

  // Spelled-out phrases (looser match — substring)
  if (/GENERAL\s*ARRANGEMENT/.test(haystack)) return true;
  if (/\bGEN[\s\.]*ARR\b/.test(haystack)) return true;

  // Standalone "GA" token (avoid matching inside words like "GAUGE", "MEGAWATT")
  // Look for GA as its own token in filename or title.
  const tokenRe = /(?:^|[\s_\-\.\(\)\[\]\/])GA(?:[\s_\-\.\(\)\[\]\/]|$)/;
  if (tokenRe.test(fn))    return true;
  if (tokenRe.test(title)) return true;
  if (/\bGA\b/.test(dt))   return true;

  return false;
}

function findRoot(parent, x) {
  if (parent[x] !== x) {
    parent[x] = findRoot(parent, parent[x]);
  }
  return parent[x];
}

function union(parent, rank, x, y) {
  const rx = findRoot(parent, x);
  const ry = findRoot(parent, y);
  if (rx === ry) return;
  if (rank[rx] < rank[ry]) {
    parent[rx] = ry;
  } else if (rank[rx] > rank[ry]) {
    parent[ry] = rx;
  } else {
    parent[ry] = rx;
    rank[rx]++;
  }
}

/**
 * Analyzes the given excel buffer to find document relationships
 * @param {Buffer} buffer Excel file buffer
 * @returns {Promise<Object>} JSON structure of groups and relationships
 */
export async function analyzeRelationships(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, dense: false });
  const { name, aoa, headerRow, score: headerScore } = pickBestSheetForData(wb);
  
  if (headerScore < 2) {
    throw new Error('Sheet "1. Submittal" or valid headers not found.');
  }

  const colMap = buildColMapFromHeaderRow(aoa, headerRow);
  const rows = extractCanonicalRows(aoa, headerRow, colMap);

  // Pre-process docs
  const docs = rows.map((r, i) => {
    const filename = String(r.filename || "");
    const titleRaw = r.description || r.cleanTitle || "";
    
    return {
      index: i,
      raw: r,
      filename: filename,
      titleRaw: titleRaw,
      
      prefix: filenamePrefix(filename),
      fnTokens: tokenise(filename),
      title: titleRaw.toUpperCase().trim(),
      titleTokens: tokenise(titleRaw),
      vendor: normalVendor(r.vendorName),
      plant: (r.plant || "").toUpperCase().trim(),
      project: (r.project || "").toUpperCase().trim(),
      discipline: (r.discipline || "").toUpperCase().trim(),
      dtype: (r.documentType || "").toUpperCase().trim(),
      assetRaw: r.assetId || "",
      asset: (r.assetId || "").toUpperCase().trim(),
      assetTokens: tokenise(r.assetId, true),
      fnAssetIds: extractAssetIds(filename),
      titleAssetIds: extractAssetIds(titleRaw),
      deptCode: r.departmentCode || "",
      deptName: (r.departmentName || "").toUpperCase().trim(),
      category: (r.category || "").toUpperCase().trim(),
      // ---- Revision tracking ----
      // colRevision: what the user typed in the spreadsheet's revision column
      // fileRevision: what the filename actually says (e.g. ...-REV4.pdf → "4")
      // revision: the value we use (column wins when present; filename used as
      //           fallback). revisionConflict tells the UI to surface both.
      colRevision: r.revision || "",
      fileRevision: extractFilenameRevision(filename),
      revision: (r.revision && String(r.revision).trim())
        ? r.revision
        : extractFilenameRevision(filename),
      revisionConflict: (r.revision && extractFilenameRevision(filename))
        ? !revisionsEqual(r.revision, extractFilenameRevision(filename))
        : false,
      revisionSource: (r.revision && String(r.revision).trim())
        ? "column"
        : (extractFilenameRevision(filename) ? "filename" : "none"),
      year: extractYear(r.revisionDate),
      parentScore: getDocParentScore({
        filename: filename,
        title: titleRaw.toUpperCase().trim(),
        dtype: (r.documentType || "").toUpperCase().trim()
      })
    };
  });

  const nDocs = docs.length;
  if (nDocs < 2) return { groups: [], borderlineGroups: [], totalDocs: nDocs, totalPairs: 0 };

  const pairs = [];

  for (let i = 0; i < nDocs; i++) {
    if (!docs[i].filename) continue;
    for (let j = i + 1; j < nDocs; j++) {
      if (!docs[j].filename) continue;
      const score = computePairScore(docs[i], docs[j]);
      if (score >= MIN_SCORE) {
        const reasons = relationshipReasons(docs[i], docs[j], score);
        pairs.push({
          i, j, score, reasons,
          label: reasons.length ? reasons.join(" | ") : `Multiple weak shared signals (score: ${Math.round(score)})`
        });
      }
    }
  }

  // A pair is "strong" only if score >= STRONG_SCORE AND it has enough independent evidence,
  // OR it scores so high (OVERRIDE_SCORE) that a single reason is enough.
  const isStrongPair = (p) =>
    (p.score >= STRONG_SCORE && p.reasons.length >= MIN_REASONS_FOR_STRONG) ||
    p.score >= OVERRIDE_SCORE;

  // ---- Strong clustering (only confident pairs participate) ----
  const parent = Array.from({ length: nDocs }, (_, i) => i);
  const rank = Array(nDocs).fill(0);
  for (const p of pairs) {
    if (isStrongPair(p)) union(parent, rank, p.i, p.j);
  }

  const inStrongCluster = new Set();
  const clusterMap = new Map();
  let clusterIdx = 0;
  for (let i = 0; i < nDocs; i++) {
    if (!docs[i].filename) continue;
    // Only count docs that actually participated in a strong pair
    const hasStrongLink = pairs.some(p => isStrongPair(p) && (p.i === i || p.j === i));
    if (!hasStrongLink) continue;
    const root = findRoot(parent, i);
    if (!clusterMap.has(root)) clusterMap.set(root, clusterIdx++);
    inStrongCluster.add(i);
  }

  const clusters = Array.from({ length: clusterIdx }, () => []);
  for (const i of inStrongCluster) {
    const root = findRoot(parent, i);
    clusters[clusterMap.get(root)].push(docs[i]);
  }

  // Helper: build a group payload from a doc cluster using the given pair pool.
  // For every child we prefer the direct pair to the parent; if there is none,
  // we take the BEST scoring pair touching the child anywhere in the cluster.
  // We *do not* relax the score floor — the pool was already filtered to the
  // tier of interest (strong or borderline).
  const buildGroup = (clusterDocs, pairPool, minPairScore) => {
    // Pick parent using cluster context (filename containment, revision, …)
    const choice = chooseClusterParent(clusterDocs, pairPool);
    const bestParent = choice.doc;

    const parentNode = {
      index: bestParent.index,
      filename: bestParent.filename,
      description: bestParent.raw.description || "",
      vendor: bestParent.vendor,
      plant: bestParent.raw.plant || "",
      project: bestParent.raw.project || "",
      docType: bestParent.raw.documentType || "",
      discipline: bestParent.raw.discipline || "",
      revision: bestParent.revision || "",
      colRevision: bestParent.colRevision || "",
      fileRevision: bestParent.fileRevision || "",
      revisionConflict: !!bestParent.revisionConflict,
      revisionSource: bestParent.revisionSource || "none",
      isParent: true,
      parentReasons: choice.reasons,
      children: []
    };

    const clusterIdxSet = new Set(clusterDocs.map(x => x.index));

    let scoreSum = 0;
    let minLinkScore = Infinity;
    let evidenceCount = 0;

    for (const d of clusterDocs) {
      if (d.index === bestParent.index) continue;

      // Direct pair to parent (preferred)
      let directPair = pairPool.find(p =>
        (p.i === d.index && p.j === bestParent.index) ||
        (p.j === d.index && p.i === bestParent.index)
      );

      // All pairs from this child to ANY OTHER doc in the cluster, best first
      const transitive = pairPool
        .filter(p => {
          const involvesD = p.i === d.index || p.j === d.index;
          if (!involvesD) return false;
          const other = p.i === d.index ? p.j : p.i;
          return clusterIdxSet.has(other);
        })
        .sort((a, b) => b.score - a.score);

      const bestPair = directPair || transitive[0];
      if (!bestPair) continue; // should be impossible but stay defensive
      if (typeof minPairScore === "number" && bestPair.score < minPairScore) continue;

      // Build the reason list shown in the UI. Start with the chosen pair's
      // reasons. If we had to fall back to a transitive pair, prepend a hint
      // so the user understands the link is indirect.
      let linkReasons = (bestPair.reasons || []).slice();
      if (!directPair && transitive.length) {
        const otherIdx = bestPair.i === d.index ? bestPair.j : bestPair.i;
        const otherDoc = clusterDocs.find(x => x.index === otherIdx);
        if (otherDoc) {
          linkReasons = [
            `Linked via "${otherDoc.filename}" (transitive)`,
            ...linkReasons
          ];
        }
      }

      parentNode.children.push({
        index: d.index,
        filename: d.filename,
        description: d.raw.description || "",
        vendor: d.vendor,
        plant: d.raw.plant || "",
        project: d.raw.project || "",
        docType: d.raw.documentType || "",
        discipline: d.raw.discipline || "",
        revision: d.revision || "",
        colRevision: d.colRevision || "",
        fileRevision: d.fileRevision || "",
        revisionConflict: !!d.revisionConflict,
        revisionSource: d.revisionSource || "none",
        isParent: false,
        relationshipLabel: linkReasons.join(" | "),
        relationshipScore: bestPair.score,
        reasons: linkReasons
      });

      scoreSum += bestPair.score;
      if (bestPair.score < minLinkScore) minLinkScore = bestPair.score;
      evidenceCount += linkReasons.length;
    }

    // Sort children by their link score (best first)
    parentNode.children.sort((a, b) => b.relationshipScore - a.relationshipScore);

    const childCount = parentNode.children.length || 1;
    const avgScore = scoreSum / childCount;
    if (!Number.isFinite(minLinkScore)) minLinkScore = 0;

    let confidence = "likely";
    if (avgScore >= 95) confidence = "almost-certain";
    else if (avgScore >= 80) confidence = "certain";

    return {
      size: parentNode.children.length + 1, // parent + actual valid children
      parent: parentNode,
      avgScore: Math.round(avgScore),
      minScore: Math.round(minLinkScore),
      evidenceCount,
      confidence
    };
  };

  // Sort strong clusters by quality (highest avg score, then size)
  const strongGroupsRaw = [];
  const strongPool = pairs.filter(isStrongPair);
  for (const c of clusters) {
    if (c.length < 2) continue;
    const g = buildGroup(c, strongPool, STRONG_SCORE);
    if (g.parent.children.length === 0) continue; // skip if no children survived the floor
    strongGroupsRaw.push(g);
  }
  strongGroupsRaw.sort((a, b) => b.avgScore - a.avgScore || b.size - a.size);
  const groups = strongGroupsRaw.map((g, i) => ({ id: i + 1, ...g }));

  // ---- Borderline clustering (pairs that didn't make the strong cut) ----
  // Anything 35..STRONG_SCORE-1, OR scoring >= STRONG_SCORE but lacking evidence.
  // Excludes docs already placed in a strong group.
  const borderlinePairs = pairs.filter(p => !isStrongPair(p));
  const bParent = Array.from({ length: nDocs }, (_, i) => i);
  const bRank = Array(nDocs).fill(0);
  for (const p of borderlinePairs) {
    if (inStrongCluster.has(p.i) || inStrongCluster.has(p.j)) continue;
    union(bParent, bRank, p.i, p.j);
  }
  const bClusterMap = new Map();
  let bIdx = 0;
  const docsInBorderlinePair = new Set();
  for (const p of borderlinePairs) {
    if (inStrongCluster.has(p.i) || inStrongCluster.has(p.j)) continue;
    docsInBorderlinePair.add(p.i);
    docsInBorderlinePair.add(p.j);
  }
  for (const i of docsInBorderlinePair) {
    const root = findRoot(bParent, i);
    if (!bClusterMap.has(root)) bClusterMap.set(root, bIdx++);
  }
  const bClusters = Array.from({ length: bIdx }, () => []);
  for (const i of docsInBorderlinePair) {
    const root = findRoot(bParent, i);
    bClusters[bClusterMap.get(root)].push(docs[i]);
  }
  const borderlineRaw = [];
  for (const c of bClusters) {
    if (c.length < 2) continue;
    const g = buildGroup(c, borderlinePairs, MIN_SCORE);
    if (g.parent.children.length === 0) continue;
    borderlineRaw.push(g);
  }
  borderlineRaw.sort((a, b) => b.avgScore - a.avgScore || b.size - a.size);
  const borderlineGroups = borderlineRaw.map((g, i) => ({ id: i + 1, ...g }));

  return {
    groups,
    borderlineGroups,
    totalDocs: nDocs,
    totalPairs: pairs.length,
    strongPairs: pairs.filter(isStrongPair).length,
    thresholds: { MIN_SCORE, STRONG_SCORE, MIN_REASONS_FOR_STRONG }
  };
}

/**
 * Injects relationship flags into original Excel sheet and returns modified buffer
 */
export async function exportRelationshipsToExcel(buffer, relationshipsJSON) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  
  // Find Submittal sheet
  let ws = wb.worksheets.find(s => s.name.trim().toLowerCase() === '1. submittal');
  if (!ws) ws = wb.worksheets.find(s => /submittal/i.test(s.name)) || wb.worksheets[0];
  if (!ws) throw new Error('Sheet not found');

  // We need to map row indices. The JSON returns 0-based indices from canonical rows.
  // We need to re-find the header row to know the offset.
  const aoa = [];
  const limit = Math.min(100, ws.rowCount);
  for(let r=1; r<=limit; r++) {
    const row = ws.getRow(r);
    const arr = [];
    row.eachCell({includeEmpty: true}, (cell, c) => {
      arr[c-1] = cell.value ? String(cell.value) : "";
    });
    aoa.push(arr);
  }
  
  const { headerRow } = pickBestSheetForData(XLSX.read(buffer, { type: 'buffer' }));
  
  // Find headers for Is Parent, Is Child, Related Group
  const headerExcelRow = headerRow + 1;
  const hRow = ws.getRow(headerExcelRow);
  
  // Append columns if they don't exist
  let isParentCol = -1, isChildCol = -1, relGroupCol = -1, relLabelCol = -1;
  let maxCol = 0;
  hRow.eachCell({includeEmpty: false}, (cell, c) => {
    maxCol = Math.max(maxCol, c);
    const v = String(cell.value || "").toUpperCase().trim();
    if (v === "IS PARENT") isParentCol = c;
    if (v === "IS CHILD") isChildCol = c;
    if (v === "RELATED GROUP") relGroupCol = c;
    if (v === "RELATIONSHIP LABEL") relLabelCol = c;
  });

  if (isParentCol === -1) { isParentCol = maxCol + 1; hRow.getCell(isParentCol).value = "Is Parent"; }
  if (isChildCol === -1) { isChildCol = isParentCol + 1; hRow.getCell(isChildCol).value = "Is Child"; }
  if (relGroupCol === -1) { relGroupCol = isChildCol + 1; hRow.getCell(relGroupCol).value = "Related Group"; }
  if (relLabelCol === -1) { relLabelCol = relGroupCol + 1; hRow.getCell(relLabelCol).value = "Relationship Label"; }

  // Map canonical row indices to Excel row indices
  // The first data row is headerRow + 2 in Excel (1-based, +1 for header)
  // BUT canonical extraction skips empty rows. We need to be careful.
  // Actually, extractCanonicalRows skips rows without data in colMap.
  const colMap = buildColMapFromHeaderRow(aoa, headerRow);
  
  // We will build a mapping: extractedIndex -> excelRowNumber
  const extractedToExcelRow = [];
  for (let r = headerRow + 1; r < ws.rowCount; r++) {
    const er = r + 1; // 1-based excel row
    const rowObj = ws.getRow(er);
    // Check if it has data
    let hasData = false;
    for(const col of colMap.keys()) {
      if (rowObj.getCell(col+1).value) { hasData = true; break; }
    }
    if (hasData) {
      extractedToExcelRow.push(er);
    }
  }

  // Clear existing relationship columns for all data rows
  for(let er of extractedToExcelRow) {
    ws.getCell(er, isParentCol).value = "";
    ws.getCell(er, isChildCol).value = "";
    ws.getCell(er, relGroupCol).value = "";
    ws.getCell(er, relLabelCol).value = "";
  }

  // Populate from JSON
  for (const group of relationshipsJSON.groups) {
    const groupId = "Group " + group.id;
    
    // Parent
    let er = extractedToExcelRow[group.parent.index];
    if (er) {
      ws.getCell(er, isParentCol).value = "TRUE";
      ws.getCell(er, isChildCol).value = "FALSE";
      ws.getCell(er, relGroupCol).value = groupId;
      ws.getCell(er, relLabelCol).value = "Parent Document";
    }

    // Children
    for (const child of group.parent.children) {
      er = extractedToExcelRow[child.index];
      if (er) {
        ws.getCell(er, isParentCol).value = "FALSE";
        ws.getCell(er, isChildCol).value = "TRUE";
        ws.getCell(er, relGroupCol).value = groupId;
        ws.getCell(er, relLabelCol).value = child.relationshipLabel;
      }
    }
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
