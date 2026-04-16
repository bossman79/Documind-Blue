/**
 * Converts extracted document metadata to CSV format matching Parse Sheet Example.csv.
 * Filename is always first. All schema field descriptions and aliases remain used during extraction;
 * this utility only formats the output.
 *
 * Header order: Filename, Issue Status, Revision, Revision Date, Description / Title,
 * Discipline, Category, Asset / ID Number, Project, Plant, Department Code,
 * Document Type, Vendor Name
 */
const FIELD_TO_HEADER = [
  ["filename", "Filename"],
  ["issue_status", "Issue Status"],
  ["revision", "Revision"],
  ["revision_date", "Revision Date"],
  ["description_title", "Description / Title"],
  ["discipline", "Discipline"],
  ["category", "Category"],
  ["asset_id_number", "Asset / ID Number"],
  ["project", "Project"],
  ["plant", "Plant"],
  ["department_code", "Department Code"],
  ["document_type", "Document Type"],
  ["vendor_name", "Vendor Name"],
];

function escapeCSV(value) {
  if (value == null || value === "") return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Converts extracted metadata object to CSV string.
 * @param {Object} data - Extracted data (flat object with schema field names)
 * @returns {string} CSV content with header row and one data row
 */
export function extractToCSV(data) {
  if (!data || typeof data !== "object") return "";
  const headers = FIELD_TO_HEADER.map(([, h]) => h);
  const values = FIELD_TO_HEADER.map(([key]) => escapeCSV(data[key]));
  return [headers.join(","), values.join(",")].join("\n");
}

/**
 * Converts an array of extracted metadata objects to a multi-row CSV string.
 * @param {Object[]} dataArray - Array of extracted data objects
 * @returns {string} CSV content with header row and one data row per document
 */
export function extractBatchToCSV(dataArray) {
  if (!Array.isArray(dataArray) || dataArray.length === 0) return "";
  const headers = FIELD_TO_HEADER.map(([, h]) => h);
  const rows = dataArray
    .filter((d) => d && typeof d === "object")
    .map((data) => FIELD_TO_HEADER.map(([key]) => escapeCSV(data[key])).join(","));
  return [headers.join(","), ...rows].join("\n");
}
