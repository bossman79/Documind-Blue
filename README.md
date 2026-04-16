
<a href="https://discord.gg/w2Ejj36hRU">
  <img src="https://user-images.githubusercontent.com/31022056/158916278-4504b838-7ecb-4ab9-a900-7dc002aade78.png" alt="Join us on Discord" width="200px">
</a>

# Documind

**`Documind`** is an advanced document processing tool that leverages AI to extract structured data from PDFs and **DWG** drawings. **`.dwg`** rasterization uses **AutoCAD Core Console** (PDF then image pipeline), or an optional **`DOCUMIND_DWG_RASTER_CMD`** override; failed conversions are retried before the job gives up.

## **Features**

- Extracts structured JSON output from unstructured documents.
- Converts documents into Markdown format.
- Supports custom schemas for data extraction.
- Includes pre-defined templates for common schemas.
- Works with OpenAI and custom LLM setups (Llava and Llama3.2-vision).
- Auto-generates schemas based on document content.

### Try the Hosted Version 🚀

The hosted version provides a seamless experience with fully managed APIs, so you can skip the setup and start extracting data right away. [Join the beta](https://documind.xyz/signup) to get access to the hosted service. 

In the meantime, you can explore the playground [here](https://www.documind.xyz/playground). Upload your documents and extract structured data with your own custom schema, or use one of the sample documents and template schemas.

## Roadmap

### ✅ Released Features  
- [x] PDF Extraction  
- [x] Basic Schema Definition  
- [x] Structured JSON Output  
- [x] Template Schemas  
- [x] Local LLM Integration (Llava and Llama3.2)  
- [x] Auto-generated Schemas  
- [x] Documnt Formatters (Text and Markdown)  
- [x] Multi-file Support (DOCX, DWG, PNG, JPG, TXT, HTML)  
- [x] Additional Schema Field Types (Boolean and Enum)

### 🚧 Upcoming Features  
- [ ] Extended LLM Support (Local and cloud)  
- [ ] Image Data Extraction  
- [ ] Advanced Document Formatters  
- [ ] Data Classification

## **Requirements**

Before using **`documind`**, ensure the following software dependencies are installed:

### **System Dependencies**

- **Ghostscript**: **`documind`** relies on Ghostscript for handling certain PDF operations.
- **GraphicsMagick**: Required for image processing within document conversions.
- **AutoCAD Core Console** (best **`.dwg`** fidelity when installed): on Windows, if **`accoreconsole.exe`** is found under **`Program Files\Autodesk\...`** (or set **`DOCUMIND_ACCORECONSOLE_PATH`**), Documind runs **`/i` drawing `/s` script** (see [Autodesk command-line switch reference](https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-Core/files/GUID-8E54B6EC-5B52-4F62-B7FC-0D4E1EDF093A.htm)) to produce a PDF, then rasterizes it like any PDF. Discovery **prefers full AutoCAD** over **DWG TrueView** (TrueView’s headless console often hits config locks and is a weaker plot target). Optional **`DOCUMIND_ACCORECONSOLE_SCRIPT`**: path to your **`.scr`** (e.g. a [plot-to-PDF script](https://gist.githubusercontent.com/erfg12/cb7d7c5ddc9b60d406f6ebbb09253dc7/raw/8178811adf09e086f29ec6aabd7882356e496f22/plotPDF.scr)); replace the output placeholder with **`PDF_FILE_NAME_HERE`** or **`{{OUTPUT_PDF}}`** (forward slashes). **`DOCUMIND_ACCORE_LAYOUT`**: layout name for the built-in script (default: omit = model **ZOOM** then **Extents**). After **`-EXPORT` `Pdf`**, AutoCAD may ask either **`[Display/Extents/Window]`** (blank ⇒ **Display** ⇒ “no plottable sheets” on many model-only DWGs) or **`[Current layout/All layouts]`** (where **`Extents`** is invalid). The built-in script therefore tries **`Extents`**, then a **blank** line, on each run unless **`DOCUMIND_ACCORE_EXPORT_PLOT_AREA`** is set (single forced answer; may be empty for blank). PDF output paths use the **long** form of `%LOCALAPPDATA%`. **`DOCUMIND_ACCORE_SKIP_INPUT_COPY=1`** skips copying the DWG into the temp folder before Accore (default copy reduces “file in use” when the drawing is open elsewhere). **Accore is serialized** by default (one `accoreconsole.exe` at a time) to reduce load when many batch workers fire at once; set **`DOCUMIND_ACCORE_SERIAL=0`** to allow parallel instances again if your machine handled that fine. **`DOCUMIND_ACCORE_BETWEEN_RUNS_MS`** (default **800**, when serial) pauses after each run; set **0** to drop only that pause. **`DOCUMIND_ACCORE_USE_ISOLATE=1`** adds **`/isolate`** (off by default — on AutoCAD 2025, **`/isolate` before `/i`** is misparsed and breaks with “Failed to create missing user data folder”). Optional **`DOCUMIND_ACCORE_LANG`** (e.g. **`en-US`**) adds **`/l`**. Output paths in generated scripts are **quoted** so Windows drive letters (`C:`) are not parsed as commands; custom **`.scr`** files get **`PDF_FILE_NAME_HERE` / `{{OUTPUT_PDF}}`** replaced with a quoted path, or use **`{{OUTPUT_PDF_UNQUOTED}}`** if you already wrap quotes yourself. **`DOCUMIND_ACCORECONSOLE_TIMEOUT_MS`**, **`DOCUMIND_SKIP_ACCORECONSOLE=1`** skips Accore (`.dwg` fails unless **`DOCUMIND_DWG_RASTER_CMD`** is set). On failure, the same drawing is retried **`DOCUMIND_DWG_CONVERSION_ATTEMPTS`** times (default **3**: initial run plus two retries), waiting **`DOCUMIND_DWG_RETRY_DELAY_MS`** between attempts (default **3000**). **Optional custom raster:** **`DOCUMIND_DWG_RASTER_CMD`** (`{input}`, `{outdir}`). **Smoke test:** `powershell -File scripts\test-accore-dwg.ps1`.
- **LibreOffice**: used for **DOCX→PDF** (via `libreoffice-convert`). It is **not** committed in git. **`start-gui.bat`** sets **`DOCUMIND_PROJECT_ROOT`** and prepends **`LibreOffice\program`** or the first **`LibreOfficePortable\...\program\`** (PortableApps layout) to `PATH`. Core also searches those folders without relying on cwd. Optional script: `scripts\download-libreoffice-portable.ps1`. **No admin:** `winget install TheDocumentFoundation.LibreOffice --scope user` (LocalAppData). Or **`DOCUMIND_SOFFICE_PATH`**.

Install both on your system before proceeding:

```bash
# On macOS
brew install ghostscript graphicsmagick

# On Debian/Ubuntu
sudo apt-get update
sudo apt-get install -y ghostscript graphicsmagick

```

### **Node.js & NPM**

Ensure Node.js (v18+) and NPM are installed on your system.

## **Installation**

You can install **`documind`** via npm:

```bash
npm install documind

```

### **Environment Setup**

**`documind`** requires an **`.env`** file to store sensitive information like your OpenAI API key.

Create an **`.env`** file in your project directory and add the following:

```bash
OPENAI_API_KEY=your_openai_api_key
```

## **Usage**

### **Basic Example**

First, import **`documind`** and define your schema. The schema outline what information **`documind`** should look for in each document. Here’s a quick setup to get started.

### **1. Define a Schema**

The schema is an array of objects where each object defines:

- **name**: Field name to extract.
- **type**: Data type (e.g., **`"string"`**, **`"number"`**, **`"array"`**, **`"object"`**).
- **description**: Description of the field.
- **children** (optional): For arrays and objects, define nested fields.

Example schema for a bank statement:

```jsx
const schema = [
  {
    name: "accountNumber",
    type: "string",
    description: "The account number of the bank statement."
  },
  {
    name: "openingBalance",
    type: "number",
    description: "The opening balance of the account."
  },
  {
    name: "transactions",
    type: "array",
    description: "List of transactions in the account.",
    children: [
      {
        name: "date",
        type: "string",
        description: "Transaction date."
      },
      {
        name: "creditAmount",
        type: "number",
        description: "Credit Amount of the transaction."
      },
      {
        name: "debitAmount",
        type: "number",
        description: "Debit Amount of the transaction."
      },
      {
        name: "description",
        type: "string",
        description: "Transaction description."
      }
    ]
  },
  {
    name: "closingBalance",
    type: "number",
    description: "The closing balance of the account."
  }
];

```

### **2. Run `documind`**

Use **`documind`** to process a PDF by passing the file URL and the schema.

```jsx
import { extract } from 'documind';

const runExtraction = async () => {
  const result = await extract({
    file: 'https://bank_statement.pdf',
    schema
  });

  console.log("Extracted Data:", result);
};

runExtraction();

```

### **Example Output**

Here’s an example of what the extracted result might look like:

```json
 {
  "success": true,
  "pages": 1,
  "data": {
    "accountNumber": "100002345",
    "openingBalance": 3200,
    "transactions": [
        {
        "date": "2021-05-12",
        "creditAmount": null,
        "debitAmount": 100,
        "description": "transfer to Tom" 
      },
      {
        "date": "2021-05-12",
        "creditAmount": 50,
        "debitAmount": null,
        "description": "For lunch the other day"
      },
      {
        "date": "2021-05-13",
        "creditAmount": 20,
        "debitAmount": null,
        "description": "Refund for voucher"
      },
      {
        "date": "2021-05-13",
        "creditAmount": null,
        "debitAmount": 750,
        "description": "May's rent"
      }
    ],
    "closingBalance": 2420
  },
  "fileName": "bank_statement.pdf"
}

```

Read the [documentation](https://docs.documind.xyz/guides/schema-definition) for more on how to define schemas and and enable auto-generation.

### **Templates**

Documind comes with built-in templates for extracting data from popular document types like invoices, bank statements, and more. These templates make it easier to get started without defining your own schema.

**List available templates**

You can list all available templates using the `templates.list` function.

```javascript
import { templates } from 'documind';

const templates = templates.list();
console.log(templates); // Logs all available template names
```
**Use a template**

To use a template, simply pass its name to the `extract` function along with the file you want to extract data from. Here's an example:

```javascript
import { extract } from 'documind';

const runExtraction = async () => {
  const result = await extract({
    file: 'https://bank_statement.pdf',
    template: 'bank_statement'
  });

  console.log("Extracted Data:", result);
};

runExtraction();
```
Read the [templates documentation](https://docs.documind.xyz/templates/overview) for more details on templates and how to contribute yours.

## **Using Local LLM Models**

Read more on how to use local models [here](https://docs.documind.xyz/guides/local-models).

## **Contributing**

Contributions are welcome! Please submit a pull request with any improvements or features.

## **License**

This project is licensed under the AGPL v3.0 License.

## **Credit**

This repo was built on top of [Zerox](https://github.com/getomni-ai/zerox). The MIT license from Zerox is included in the core folder and is also mentioned in the root license file.

---
