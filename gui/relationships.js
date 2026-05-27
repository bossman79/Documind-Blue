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
const W_ASSET = 12;
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

  // 9. ASSET / ID NUMBER
  if (d1.asset.length > 2 && d2.asset.length > 2) {
    if (d1.asset === d2.asset) {
      score += W_ASSET + 6;
    } else {
      score += jaccardSim(d1.assetTokens, d2.assetTokens) * W_ASSET;
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

  if (d1.asset.length > 2 && d2.asset.length > 2) {
    if (d1.asset === d2.asset) {
      reasons.push(`Identical asset/ID: ${d1.assetRaw}`);
    } else if (jaccardSim(d1.assetTokens, d2.assetTokens) >= 0.4) {
      reasons.push("Overlapping asset/ID numbers");
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

function getDocParentScore(d) {
  let score = 0;

  const fn = (d.filename || "").toUpperCase();
  let ext = "";
  const pos = fn.lastIndexOf(".");
  if (pos > 0) ext = fn.slice(pos + 1);

  if (ext === "PDF") score += 50;
  if (ext === "DWG") score += 30;
  if (["DOC", "DOCX", "XLS", "XLSX"].includes(ext)) score += 10;

  const title = d.title;
  const parentWords = ["ASSEMBLY", "ASSY", "GENERAL", "LAYOUT", "MAIN", "OVERVIEW", "SYSTEM", "PLAN"];
  const childWords = ["DETAIL", "PART", "COMPONENT", "SECTION", "LIST", "BOM", "BILL OF MATERIAL", "SCHEDULE"];

  for (const w of parentWords) {
    if (title.includes(w)) score += 25;
  }
  for (const w of childWords) {
    if (title.includes(w)) score -= 25;
  }

  const dt = d.dtype;
  if (dt.includes("DRAWING") || dt.includes("PLAN")) score += 15;
  if (dt.includes("BOM") || dt.includes("LIST")) score -= 15;

  score -= (fn.length * 0.1);

  return score;
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
      deptCode: r.departmentCode || "",
      deptName: (r.departmentName || "").toUpperCase().trim(),
      category: (r.category || "").toUpperCase().trim(),
      revision: r.revision || "",
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
    let bestParent = null;
    let bestPScore = -Infinity;
    for (const d of clusterDocs) {
      if (d.parentScore > bestPScore) {
        bestPScore = d.parentScore;
        bestParent = d;
      }
    }
    const parentNode = {
      index: bestParent.index,
      filename: bestParent.filename,
      description: bestParent.raw.description || "",
      vendor: bestParent.vendor,
      plant: bestParent.raw.plant || "",
      project: bestParent.raw.project || "",
      docType: bestParent.raw.documentType || "",
      discipline: bestParent.raw.discipline || "",
      isParent: true,
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
