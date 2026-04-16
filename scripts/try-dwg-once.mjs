import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extract } from "../extractor/src/services/extract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const schema = [
  { name: "issue_status", type: "string", description: "Issue or revision status" },
  { name: "revision", type: "string", description: "Drawing revision" },
  { name: "revision_date", type: "string", description: "Revision date" },
  { name: "description_title", type: "string", description: "Title or description" },
  { name: "discipline", type: "string", description: "Discipline" },
  { name: "category", type: "string", description: "Category" },
  { name: "asset_id_number", type: "string", description: "Asset ID" },
  { name: "project", type: "string", description: "Project number" },
  { name: "plant", type: "string", description: "Plant" },
  { name: "department_code", type: "string", description: "Department code" },
  { name: "document_type", type: "string", description: "Document type" },
  { name: "vendor_name", type: "string", description: "Vendor" },
  { name: "filename", type: "string", description: "File name" },
];

const file = path.join(__dirname, "..", "31510194_acm_003_00.dwg");
const model = process.env.EXTRACT_MODEL || "qwen3.5:9b";

console.error("[try-dwg-once] BASE_URL=", process.env.BASE_URL || "(default)");
console.error("[try-dwg-once] model=", model);
console.error("[try-dwg-once] file=", file);

const r = await extract({
  file,
  schema,
  model,
  uploadedFileName: "31510194_acm_003_00.dwg",
});
console.log(JSON.stringify(r, null, 2));
