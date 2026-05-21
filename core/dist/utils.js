"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.convertKeysToSnakeCase = exports.convertFileToPdf = exports.convertPdfToImages = exports.correctImageOrientation = exports.getTextFromImage = exports.downloadFile = exports.getPdfPageCount = exports.getOllamaApiKeys = exports.ollamaKeyState = exports.isValidUrl = exports.isString = exports.formatMarkdown = exports.encodeImageToBase64 = exports.validateLLMParams = void 0;
exports.getAccoreConversionOptions = getAccoreConversionOptions;
exports.convertDwgToOrientedPngs = convertDwgToOrientedPngs;
const libreoffice_convert_1 = require("libreoffice-convert");
const pdf2pic_1 = require("pdf2pic");
const pdf_lib_1 = require("pdf-lib");
const node_crypto_1 = require("node:crypto");
const child_process_1 = require("child_process");
const promises_1 = require("stream/promises");
const util_1 = require("util");
const Tesseract = __importStar(require("tesseract.js"));
const axios_1 = __importDefault(require("axios"));
const fs_extra_1 = __importDefault(require("fs-extra"));
const quotaUsage_1 = require("./quotaUsage");
const mime_types_1 = __importDefault(require("mime-types"));
const path_1 = __importDefault(require("path"));
const sharp_1 = __importDefault(require("sharp"));
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const execAsync = (0, util_1.promisify)(child_process_1.exec);
const convertAsync = (0, util_1.promisify)(libreoffice_convert_1.convert);
const defaultLLMParams = {
    frequencyPenalty: 0, // OpenAI defaults to 0
    maxTokens: 4000,
    presencePenalty: 0, // OpenAI defaults to 0
    temperature: 0,
    topP: 1, // OpenAI defaults to 1
    topK: undefined, // Ollama-specific (e.g. Gemma 4 recommends 64)
};
const validateLLMParams = (params) => {
    const validKeys = Object.keys(defaultLLMParams);
    for (const [key, value] of Object.entries(params)) {
        if (!validKeys.includes(key)) {
            throw new Error(`Invalid LLM parameter: ${key}`);
        }
        if (typeof value !== "number") {
            throw new Error(`Value for '${key}' must be a number`);
        }
    }
    return { ...defaultLLMParams, ...params };
};
exports.validateLLMParams = validateLLMParams;
/** Ollama Cloud (and some OpenAI-compatible hosts) reject data-URIs over ~10MiB. */
const DEFAULT_MAX_VISION_BASE64_CHARS = 10 * 1024 * 1024 - 2048;
/**
 * Encode a page image for vision LLMs. Recompresses with sharp (JPEG) and downscales
 * until the base64 payload stays under the provider limit — avoids 400 on huge PNGs from pdf2pic.
 */
const encodeImageToBase64 = async (imagePath, options) => {
    const maxB64 = (() => {
        const raw = process.env.DOCUMIND_MAX_VISION_BASE64_CHARS;
        if (raw && /^\d+$/.test(raw.trim()))
            return parseInt(raw.trim(), 10);
        return DEFAULT_MAX_VISION_BASE64_CHARS;
    })();
    const envLong = process.env.DOCUMIND_VISION_INITIAL_LONG_SIDE?.trim();
    const fromEnv = envLong && /^\d+$/.test(envLong) ? parseInt(envLong, 10) : undefined;
    let longSide = options?.initialLongSide ??
        fromEnv ??
        2560;
    try {
        let quality = 88;
        for (let attempt = 0; attempt < 22; attempt++) {
            const buf = await (0, sharp_1.default)(imagePath, { failOn: "truncated" })
                .rotate()
                .resize({
                width: longSide,
                height: longSide,
                fit: "inside",
                withoutEnlargement: true,
            })
                .jpeg({ quality, mozjpeg: true })
                .toBuffer();
            const b64 = buf.toString("base64");
            if (b64.length <= maxB64) {
                return b64;
            }
            longSide = Math.max(320, Math.floor(longSide * 0.82));
            quality = Math.max(48, quality - 3);
        }
        const buf = await (0, sharp_1.default)(imagePath, { failOn: "truncated" })
            .rotate()
            .resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 45, mozjpeg: true })
            .toBuffer();
        const b64 = buf.toString("base64");
        if (b64.length <= maxB64)
            return b64;
        throw new Error(`Vision image still exceeds max base64 length (${b64.length} > ${maxB64}) after recompress: ${imagePath}`);
    }
    catch (err) {
        const raw = await fs_extra_1.default.readFile(imagePath);
        const b64 = raw.toString("base64");
        if (b64.length <= maxB64) {
            return b64;
        }
        throw new Error(`Could not shrink image for vision API (${imagePath}): ${err instanceof Error ? err.message : String(err)}`);
    }
};
exports.encodeImageToBase64 = encodeImageToBase64;
// Strip out the ```markdown wrapper
const formatMarkdown = (text) => {
    let formattedMarkdown = text?.trim();
    let loopCount = 0;
    const maxLoops = 3;
    const startsWithMarkdown = formattedMarkdown.startsWith("```markdown");
    while (startsWithMarkdown && loopCount < maxLoops) {
        const endsWithClosing = formattedMarkdown.endsWith("```");
        if (startsWithMarkdown && endsWithClosing) {
            const outermostBlockRegex = /^```markdown\n([\s\S]*?)\n```$/;
            const match = outermostBlockRegex.exec(formattedMarkdown);
            if (match) {
                formattedMarkdown = match[1].trim();
                loopCount++;
            }
            else {
                break;
            }
        }
        else {
            break;
        }
    }
    return formattedMarkdown;
};
exports.formatMarkdown = formatMarkdown;
const isString = (value) => {
    return value !== null;
};
exports.isString = isString;
const isValidUrl = (string) => {
    let url;
    try {
        url = new URL(string);
    }
    catch (_) {
        return false;
    }
    return url.protocol === "http:" || url.protocol === "https:";
};
exports.isValidUrl = isValidUrl;
/** Shared state for Ollama key failover — core (vision) and extractor both use this so we don't retry rate-limited keys twice. */
exports.ollamaKeyState = {
    lastSuccessfulKeyIndex: 0,
    rateLimitedKeyIndices: new Set(),
};
/** Get Ollama API keys from env. Puts OLLAMA_API_KEY first if set, then OLLAMA_API_KEYS (comma-sep) or OLLAMA_API_KEY_2..N. */
const getOllamaApiKeys = () => {
    const keys = [];
    const primary = process.env.OLLAMA_API_KEY?.trim();
    if (primary)
        keys.push(primary);
    const fromList = process.env.OLLAMA_API_KEYS;
    if (fromList && typeof fromList === "string") {
        const parts = fromList.split(",").map((s) => s.trim()).filter(Boolean);
        for (const p of parts) {
            if (p && !keys.includes(p))
                keys.push(p);
        }
    }
    else if (keys.length <= 1) {
        for (let i = 2; i <= quotaUsage_1.OLLAMA_QUOTA_KEY_COUNT; i++) {
            const extra = process.env[`OLLAMA_API_KEY_${i}`];
            if (extra && typeof extra === "string")
                keys.push(extra.trim());
        }
    }
    return keys.slice(0, quotaUsage_1.OLLAMA_QUOTA_KEY_COUNT);
};
exports.getOllamaApiKeys = getOllamaApiKeys;
/** Get the number of pages in a PDF file. Returns null if the PDF is malformed and page count cannot be determined. */
const getPdfPageCount = async (pdfPath) => {
    try {
        const buffer = await fs_extra_1.default.readFile(pdfPath);
        const doc = await pdf_lib_1.PDFDocument.load(buffer, { ignoreEncryption: true });
        return doc.getPageCount();
    }
    catch (err) {
        console.warn("Could not determine PDF page count (malformed or corrupted structure). Processing all pages.", err instanceof Error ? err.message : String(err));
        return null;
    }
};
exports.getPdfPageCount = getPdfPageCount;
// Save file to local tmp directory
const downloadFile = async ({ filePath, tempDir, }) => {
    // Shorten the file name by removing URL parameters
    const baseFileName = path_1.default.basename(filePath.split("?")[0]);
    const localPath = path_1.default.join(tempDir, baseFileName);
    let mimetype;
    // Check if filePath is a URL
    if ((0, exports.isValidUrl)(filePath)) {
        const writer = fs_extra_1.default.createWriteStream(localPath);
        const response = await (0, axios_1.default)({
            url: filePath,
            method: "GET",
            responseType: "stream",
        });
        if (response.status !== 200) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        mimetype = response.headers?.["content-type"];
        await (0, promises_1.pipeline)(response.data, writer);
    }
    else {
        // If filePath is a local file, copy it to the temp directory
        await fs_extra_1.default.copyFile(filePath, localPath);
    }
    if (!mimetype) {
        mimetype = mime_types_1.default.lookup(localPath);
    }
    let extension = mime_types_1.default.extension(mimetype) || "";
    if (!extension) {
        if (mimetype === "binary/octet-stream") {
            extension = ".bin";
        }
        else {
            throw new Error("File extension missing");
        }
    }
    if (!extension.startsWith(".")) {
        extension = `.${extension}`;
    }
    const pathExt = path_1.default.extname(localPath).toLowerCase();
    if (extension === ".bin" && pathExt === ".dwg") {
        extension = ".dwg";
    }
    return { extension, localPath };
};
exports.downloadFile = downloadFile;
// Extract text confidence from image buffer using Tesseract
const getTextFromImage = async (buffer) => {
    try {
        // Get image and metadata
        const image = (0, sharp_1.default)(buffer);
        const metadata = await image.metadata();
        // Crop to a 150px wide column in the center of the document.
        // This section produced the highest confidence/speed tradeoffs.
        const cropWidth = 150;
        const cropHeight = metadata.height || 0;
        const left = Math.max(0, Math.floor((metadata.width - cropWidth) / 2));
        const top = 0;
        // Extract the cropped image
        const croppedBuffer = await image
            .extract({ left, top, width: cropWidth, height: cropHeight })
            .toBuffer();
        // Pass the croppedBuffer to Tesseract.recognize.
        // user_defined_dpi suppresses "Invalid resolution X dpi. Using 70 instead" from images with bad metadata.
        // @TODO: How can we generalize this to non eng languages?
        const worker = await Tesseract.createWorker("eng", 1);
        try {
            await worker.setParameters({ user_defined_dpi: "300" });
            const { data: { confidence }, } = await worker.recognize(croppedBuffer);
            return { confidence };
        }
        finally {
            await worker.terminate();
        }
    }
    catch (error) {
        console.error("Error during OCR:", error);
        return { confidence: 0 };
    }
};
exports.getTextFromImage = getTextFromImage;
// Correct image orientation based on OCR confidence
// Run Tesseract on 4 different orientations of the image and compare the output
const correctImageOrientation = async (buffer) => {
    const image = (0, sharp_1.default)(buffer);
    const rotations = [0, 90, 180, 270];
    const results = await Promise.all(rotations.map(async (rotation) => {
        const rotatedImageBuffer = await image
            .clone()
            .rotate(rotation)
            .toBuffer();
        const { confidence } = await (0, exports.getTextFromImage)(rotatedImageBuffer);
        return { rotation, confidence };
    }));
    // Find the rotation with the best confidence score
    const bestResult = results.reduce((best, current) => current.confidence > best.confidence ? current : best);
    if (bestResult.rotation !== 0) {
        console.log(`Reorienting image ${bestResult.rotation} degrees (Confidence: ${bestResult.confidence}%).`);
    }
    // Rotate the image to the best orientation
    const correctedImageBuffer = await image
        .rotate(bestResult.rotation)
        .toBuffer();
    return correctedImageBuffer;
};
exports.correctImageOrientation = correctImageOrientation;
// Convert each page to a png, correct orientation, and save that image to tmp
const convertPdfToImages = async ({ localPath, pagesToConvertAsImages, tempDir, imageBaseName, }) => {
    const options = {
        density: 300,
        format: "png",
        height: 2048,
        preserveAspectRatio: true,
        saveFilename: imageBaseName ?? path_1.default.basename(localPath, path_1.default.extname(localPath)),
        savePath: tempDir,
    };
    const storeAsImage = (0, pdf2pic_1.fromPath)(localPath, options);
    try {
        const convertResults = await storeAsImage.bulk(pagesToConvertAsImages, {
            responseType: "buffer",
        });
        await Promise.all(convertResults.map(async (result, index) => {
            // ONLY process the first and last page
            if (index !== 0 && index !== convertResults.length - 1)
                return;
            if (!result || !result.buffer) {
                console.warn(`Skipping page ${index + 1}: no buffer available`);
                return;
            }
            if (!result.page) {
                console.warn(`Skipping page ${index + 1}: no page data`);
                return;
            }
            const paddedPageNumber = result.page.toString().padStart(5, "0");
            // Correct the image orientation
            const correctedBuffer = await (0, exports.correctImageOrientation)(result.buffer);
            const imagePath = path_1.default.join(tempDir, `${options.saveFilename}_page_${paddedPageNumber}.png`);
            await fs_extra_1.default.writeFile(imagePath, correctedBuffer);
        }));
        return convertResults;
    }
    catch (err) {
        console.error("Error during PDF conversion:", err);
        throw err;
    }
};
exports.convertPdfToImages = convertPdfToImages;
const INTERMEDIATE_DWG_PNG_REGEX = /_page_\d{5}\.png$/i;
function isIntermediateDwgRasterPng(filename) {
    if (!filename.toLowerCase().endsWith(".png"))
        return false;
    return !INTERMEDIATE_DWG_PNG_REGEX.test(filename);
}
/**
 * AutoCAD Core Console (AccoreConsole.exe): headless DWG engine shipped with AutoCAD / AutoCAD LT.
 * Docs: https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-Core/files/GUID-8E54B6EC-5B52-4F62-B7FC-0D4E1EDF093A.htm
 * Example script pattern: https://gist.githubusercontent.com/erfg12/cb7d7c5ddc9b60d406f6ebbb09253dc7/raw/8178811adf09e086f29ec6aabd7882356e496f22/plotPDF.scr
 */
async function findAccoreConsoleBinary() {
    if (process.env.DOCUMIND_SKIP_ACCORECONSOLE === "1")
        return null;
    const fromEnv = process.env.DOCUMIND_ACCORECONSOLE_PATH?.trim();
    if (fromEnv) {
        if (await fs_extra_1.default.pathExists(fromEnv))
            return fromEnv;
        return null;
    }
    if (process.platform !== "win32")
        return null;
    const roots = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"]].filter(Boolean);
    const candidates = [];
    for (const root of roots) {
        const autodesk = path_1.default.join(root, "Autodesk");
        if (!(await fs_extra_1.default.pathExists(autodesk)))
            continue;
        let entries;
        try {
            entries = await fs_extra_1.default.readdir(autodesk, { withFileTypes: true });
        }
        catch {
            continue;
        }
        const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
        dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const dirName of dirs) {
            const candidate = path_1.default.join(autodesk, dirName, "accoreconsole.exe");
            if (await fs_extra_1.default.pathExists(candidate))
                candidates.push(candidate);
        }
    }
    if (candidates.length === 0)
        return null;
    /** DWG TrueView ships accoreconsole.exe but it often fails headless (config under Program Files, no full plot stack). Prefer full AutoCAD. */
    const nonTrueView = candidates.filter((p) => !/trueview/i.test(p));
    const pool = nonTrueView.length > 0 ? nonTrueView : candidates;
    pool.sort((a, b) => path_1.default.basename(path_1.default.dirname(b)).localeCompare(path_1.default.basename(path_1.default.dirname(a)), undefined, { numeric: true }));
    return pool[0] ?? null;
}
/** Paths for AccoreConsole `.scr` lines: forward slashes, quoted so `C:` is not parsed as a command. */
function accoreScriptPdfPathForScr(p) {
    const long = path_1.default.resolve(p);
    const fwd = long.replace(/\\/g, "/");
    return `"${fwd.replace(/"/g, '\\"')}"`;
}
/**
 * Plot-area line after `-EXPORT` `Pdf` differs by drawing/context:
 * - `[Display/Extents/Window] <Display>` — blank ⇒ Display ⇒ often "no plottable sheets" for model-heavy DWGs; use `Extents`.
 * - `[Current layout/All layouts]` — `Extents` is invalid; blank accepts Current layout.
 * When `DOCUMIND_ACCORE_EXPORT_PLOT_AREA` is set, only that value is used (trimmed; may be empty for blank).
 */
function accoreBuiltInPlotAreaStrategies() {
    const plotEnv = process.env.DOCUMIND_ACCORE_EXPORT_PLOT_AREA;
    if (plotEnv !== undefined) {
        return [plotEnv.trim()];
    }
    return ["Extents", ""];
}
function buildDefaultAccoreExportScript(pdfOutAbs, plotAreaLine) {
    const pdfQuoted = accoreScriptPdfPathForScr(pdfOutAbs);
    const layout = process.env.DOCUMIND_ACCORE_LAYOUT?.trim();
    const lines = ["_FILEDIA", "0", "_CMDDIA", "0", "REPORTERROR", "0"];
    // Pre-process: AUDIT and PURGE disabled to avoid AEC/proxy crashes in headless mode
    /*
    lines.push("_AUDIT");
    lines.push("Y");
    lines.push("_-PURGE");
    lines.push("A");
    lines.push("*");
    lines.push("N");
    */
    if (layout) {
        lines.push("_-LAYOUT", "S", layout, "_ZOOM", "E");
    }
    else {
        lines.push("_ZOOM", "E");
    }
    /* Use -PLOT instead of -EXPORT for better reliability in batch processing.
     * -PLOT is more stable in AccoreConsole and handles Model space better.
     * Reference: https://gist.github.com/erfg12/cb7d7c5ddc9b60d406f6ebbb09253dc7
     */
    lines.push("_-PLOT");
    lines.push("Y"); // Detailed plot configuration? Yes
    lines.push(layout || "Model"); // Layout name or Model
    lines.push("DWG To PDF.pc3"); // Plotter name
    lines.push(""); // Paper size (blank = use default)
    lines.push(""); // Units (blank = use default)
    lines.push(""); // Orientation (blank = use default)
    lines.push("N"); // Plot upside down? No
    lines.push(plotAreaLine || "Extents"); // Plot area
    lines.push("F"); // Scale: Fit to paper
    lines.push("C"); // Center plot? Yes
    lines.push("Y"); // Plot with plot styles? Yes
    lines.push(""); // Plot style table (blank = use default)
    lines.push("Y"); // Plot with lineweights? Yes
    lines.push("N"); // Scale lineweights? No
    lines.push("Y"); // Plot paper space last? Yes
    lines.push("N"); // Hide paperspace objects? No
    lines.push(pdfQuoted); // Output file path
    lines.push("N"); // Save changes to page setup? No
    lines.push("Y"); // Proceed with plot? Yes
    lines.push("_QUIT", "Y");
    return `${lines.join("\r\n")}\r\n`;
}
async function materializeAccoreScript(pdfOutAbs, tempDir, plotAreaLineForBuiltIn) {
    const templatePath = process.env.DOCUMIND_ACCORECONSOLE_SCRIPT?.trim();
    const scrPath = path_1.default.join(tempDir, "documind_accore_export.scr");
    const pdfQuoted = accoreScriptPdfPathForScr(pdfOutAbs);
    const pdfFwd = path_1.default.resolve(pdfOutAbs).replace(/\\/g, "/");
    const pdfWin = path_1.default.resolve(pdfOutAbs);
    if (templatePath && (await fs_extra_1.default.pathExists(templatePath))) {
        let body = await fs_extra_1.default.readFile(templatePath, "utf8");
        body = body.replace(/\{\{OUTPUT_PDF\}\}/g, pdfQuoted);
        body = body.replace(/\{\{OUTPUT_PDF_UNQUOTED\}\}/g, pdfFwd);
        body = body.replace(/\{\{OUTPUT_PDF_WINDOWS\}\}/g, pdfWin);
        body = body.replace(/PDF_FILE_NAME_HERE/g, pdfQuoted);
        await fs_extra_1.default.writeFile(scrPath, body, "utf8");
    }
    else {
        await fs_extra_1.default.writeFile(scrPath, buildDefaultAccoreExportScript(pdfOutAbs, plotAreaLineForBuiltIn), "utf8");
    }
    return scrPath;
}
function trimAccoreConsoleLog(text, maxLen = 4500) {
    const t = text.replace(/\r\n/g, "\n").trim();
    if (!t)
        return "";
    return t.length <= maxLen ? t : `…(truncated)\n${t.slice(-maxLen)}`;
}
/**
 * Resolve Accore pacing from env, with optional per-call overrides (e.g. from GUI `process.env` at extract time).
 * Empty / missing `DOCUMIND_ACCORE_BETWEEN_RUNS_MS` defaults to 800 ms (do not use `Number("")` which is 0).
 */
function getAccoreConversionOptions(override) {
    const serial = override?.serial !== undefined
        ? override.serial
        : process.env.DOCUMIND_ACCORE_SERIAL?.trim() !== "0";
    let betweenRunsMs;
    if (override?.betweenRunsMs !== undefined) {
        betweenRunsMs = Math.min(120000, Math.max(0, Math.floor(override.betweenRunsMs)));
    }
    else {
        const raw = process.env.DOCUMIND_ACCORE_BETWEEN_RUNS_MS?.trim();
        if (!raw) {
            betweenRunsMs = 5000;
        }
        else {
            const n = parseInt(raw, 10);
            betweenRunsMs = Number.isFinite(n) && n >= 0 ? Math.min(n, 120000) : 5000;
        }
    }
    return { serial, betweenRunsMs };
}
/** Local cache to avoid spawning PowerShell for the same path multiple times. */
const windowsPathCache = new Map();
/**
 * Serialize Accore: mutex + mandatory pause before releasing the next waiter (pause is inside the lock).
 */
let accoreExclusiveTail = Promise.resolve();
async function runAccoreExclusive(work, betweenRunsMs) {
    const prev = accoreExclusiveTail;
    let unblock;
    accoreExclusiveTail = new Promise((res) => {
        unblock = res;
    });
    await prev;
    try {
        return await work();
    }
    finally {
        if (betweenRunsMs > 0) {
            await new Promise((r) => setTimeout(r, betweenRunsMs));
        }
        unblock();
    }
}
function buildAccoreConsoleSpawnArgs(dwgForAccore, scrLong) {
    const args = [];
    /**
     * Do not pass `/isolate` by default: AutoCAD 2025 AccoreConsole treats the next token after
     * `/isolate` as isolate metadata, so `/isolate /i drawing.dwg` mis-parses (`regkey=/i`,
     * `userDataFolder=drawing.dwg`) and fails immediately. Opt in with DOCUMIND_ACCORE_USE_ISOLATE=1
     * only if your build documents the correct switch order/arguments.
     */
    if (process.env.DOCUMIND_ACCORE_USE_ISOLATE === "1") {
        args.push("/isolate");
    }
    const lang = process.env.DOCUMIND_ACCORE_LANG?.trim();
    if (lang) {
        args.push("/l", lang);
    }
    // /noplugins and /nodemands are critical to avoid AEC module crashes in 2025 headless.
    args.push("/nologo", "/noplugins", "/nodemands", "/i", dwgForAccore, "/s", scrLong);
    return args;
}
async function runAccoreConsoleDwgToPdf(accoreExe, dwgPath, pdfOutAbs, tempDir, plotAreaLine, accoreOpts) {
    const runInner = async () => {
        const dwgSourceAbs = await windowsLongAbsolutePath(await fs_extra_1.default.realpath(dwgPath).catch(() => dwgPath));
        /** Copy avoids Accore "file in use / read-only" when the same DWG is open in AutoCAD or the GUI. */
        let dwgForAccore = dwgSourceAbs;
        let workDwgCopy = null;
        if (process.env.DOCUMIND_ACCORE_SKIP_INPUT_COPY !== "1") {
            const ext = path_1.default.extname(dwgSourceAbs) || ".dwg";
            workDwgCopy = path_1.default.join(tempDir, `documind_accore_work_${(0, node_crypto_1.randomBytes)(8).toString("hex")}${ext}`);
            await fs_extra_1.default.copy(dwgSourceAbs, workDwgCopy);
            dwgForAccore = await windowsLongAbsolutePath(workDwgCopy);
        }
        const pdfAbs = await windowsLongAbsolutePathForNewFile(pdfOutAbs);
        await fs_extra_1.default.remove(pdfAbs).catch(() => { });
        const scrAbs = await materializeAccoreScript(pdfAbs, tempDir, plotAreaLine);
        const scrLong = await windowsLongAbsolutePath(scrAbs);
        const timeoutMs = Number(process.env.DOCUMIND_ACCORECONSOLE_TIMEOUT_MS) || 900000;
        const accoreCwd = path_1.default.dirname(accoreExe);
        let accoreLog = "";
        try {
            const spawnArgs = buildAccoreConsoleSpawnArgs(dwgForAccore, scrLong);
            const r = (await execFileAsync(accoreExe, spawnArgs, {
                windowsHide: true,
                maxBuffer: 16 * 1024 * 1024,
                timeout: timeoutMs,
                cwd: accoreCwd,
                encoding: "utf8",
                env: { ...process.env, ACADREPORTERDIR: "" },
            }));
            accoreLog = trimAccoreConsoleLog(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
        }
        catch (err) {
            const any = err;
            accoreLog = trimAccoreConsoleLog(`${any.stdout ?? ""}\n${any.stderr ?? ""}`);
            const hint = accoreLog ? `\nAccoreConsole output:\n${accoreLog}` : "";
            throw new Error(`AccoreConsole process error: ${any.message ?? String(err)}.${hint}`);
        }
        finally {
            if (workDwgCopy)
                await fs_extra_1.default.remove(workDwgCopy).catch(() => { });
        }
        if (!(await fs_extra_1.default.pathExists(pdfAbs))) {
            const logHint = accoreLog ? `\nAccoreConsole output:\n${accoreLog}\n` : "\n";
            throw new Error(`AccoreConsole finished but PDF was not created at ${pdfAbs}.${logHint}` +
                "Built-in script tries plot area `Extents` then blank unless DOCUMIND_ACCORE_EXPORT_PLOT_AREA is set. " +
                "Or use DOCUMIND_ACCORECONSOLE_SCRIPT / DOCUMIND_ACCORE_LAYOUT.");
        }
        const st = await fs_extra_1.default.stat(pdfAbs);
        if (st.size < 32) {
            await fs_extra_1.default.remove(pdfAbs).catch(() => { });
            throw new Error("AccoreConsole produced an empty or invalid PDF.");
        }
    };
    // Parallel Accore only when both: serial off AND zero pause. Any non-zero pause must use one global queue
    // or async batch workers each fire Accore at full speed and the setting appears to "do nothing".
    const gateAccore = accoreOpts.serial || accoreOpts.betweenRunsMs > 0;
    if (gateAccore) {
        await runAccoreExclusive(runInner, accoreOpts.betweenRunsMs);
    }
    else {
        await runInner();
    }
}
async function tryConvertDwgViaAccoreConsole(params) {
    const { localPath, tempDir, stem, metadataOnly, accoreOpts } = params;
    const accore = await findAccoreConsoleBinary();
    if (!accore)
        return null;
    const pdfPath = path_1.default.join(tempDir, `${stem}_documind_accore.pdf`);
    const plotStrategies = accoreBuiltInPlotAreaStrategies();
    let accorePdfOk = false;
    let lastAccoreErr = null;
    for (let si = 0; si < plotStrategies.length; si++) {
        const line = plotStrategies[si];
        const label = line === "" ? "(blank)" : JSON.stringify(line);
        try {
            await runAccoreConsoleDwgToPdf(accore, localPath, pdfPath, tempDir, line, accoreOpts);
            accorePdfOk = true;
            break;
        }
        catch (err) {
            lastAccoreErr = err;
            await fs_extra_1.default.remove(pdfPath).catch(() => { });
            const msg = err instanceof Error ? err.message : String(err);
            if (si < plotStrategies.length - 1) {
                console.warn(`[documind] AccoreConsole plot strategy ${si + 1}/${plotStrategies.length} (${label}) failed; retrying alternate… ${msg.slice(0, 500)}`);
            }
        }
    }
    if (!accorePdfOk) {
        console.warn("[documind] AccoreConsole DWG→PDF failed (all plot strategies exhausted):", lastAccoreErr instanceof Error ? lastAccoreErr.message : lastAccoreErr);
        return null;
    }
    let pageSpec = -1;
    const pageCount = await (0, exports.getPdfPageCount)(pdfPath);
    if (metadataOnly && pageCount != null && pageCount > 1) {
        pageSpec = [1, pageCount];
    }
    try {
        await (0, exports.convertPdfToImages)({
            localPath: pdfPath,
            pagesToConvertAsImages: pageSpec,
            tempDir,
            imageBaseName: stem,
        });
    }
    catch (err) {
        console.warn("[documind] AccoreConsole PDF→PNG failed:", err instanceof Error ? err.message : err);
        await fs_extra_1.default.remove(pdfPath).catch(() => { });
        return null;
    }
    await fs_extra_1.default.remove(pdfPath).catch(() => { });
    const prefix = `${stem}_page_`.toLowerCase();
    const pagePngs = (await fs_extra_1.default.readdir(tempDir))
        .filter((f) => {
        const lower = f.toLowerCase();
        return lower.endsWith(".png") && lower.startsWith(prefix);
    })
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return pagePngs.length > 0 ? pagePngs.length : null;
}
/** Expand short paths (VGIORD~1) for Win32 tooling (e.g. AccoreConsole). */
async function windowsLongAbsolutePath(absPath) {
    if (process.platform !== "win32")
        return path_1.default.resolve(absPath);
    const normalized = path_1.default.resolve(absPath);
    if (windowsPathCache.has(normalized))
        return windowsPathCache.get(normalized);
    try {
        const psLiteral = normalized.replace(/'/g, "''");
        const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Item -LiteralPath '${psLiteral}').FullName`], { windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024 });
        const longP = stdout.trim();
        if (longP && /^[A-Za-z]:[\\/]/.test(longP)) {
            const result = longP.replace(/\//g, "\\");
            windowsPathCache.set(normalized, result);
            return result;
        }
    }
    catch {
        /* use normalized */
    }
    return normalized;
}
/** Long absolute path for a file that may not exist yet (PDF output): expand the parent directory. */
async function windowsLongAbsolutePathForNewFile(absPath) {
    if (process.platform !== "win32")
        return path_1.default.resolve(absPath);
    const resolved = path_1.default.resolve(absPath);
    const dir = path_1.default.dirname(resolved);
    const base = path_1.default.basename(resolved);
    const longDir = await windowsLongAbsolutePath(dir);
    return path_1.default.join(longDir, base);
}
async function runCustomDwgRasterCommand(commandTemplate, inputPath, outputDir) {
    const cmd = commandTemplate
        .replace(/\{input\}/g, inputPath)
        .replace(/\{outdir\}/g, outputDir);
    await execAsync(cmd, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}
/** Accore path: 1 initial + 2 retries by default (`DOCUMIND_DWG_CONVERSION_ATTEMPTS`, max 10). */
function dwgAccoreMaxAttempts() {
    const n = Number(process.env.DOCUMIND_DWG_CONVERSION_ATTEMPTS);
    if (Number.isFinite(n) && n >= 1 && n <= 10)
        return Math.floor(n);
    return 3;
}
function dwgAccoreRetryDelayMs() {
    const n = Number(process.env.DOCUMIND_DWG_RETRY_DELAY_MS);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10000;
}
/**
 * Rasterize a .dwg to PNG(s) via AccoreConsole (AutoCAD), or `DOCUMIND_DWG_RASTER_CMD` with `{input}` / `{outdir}`.
 * Retries Accore up to `DOCUMIND_DWG_CONVERSION_ATTEMPTS` times before failing.
 */
async function convertDwgToOrientedPngs({ localPath, tempDir, metadataOnly, accore, }) {
    const accoreOpts = getAccoreConversionOptions(accore);
    // Sanitize stem to avoid encoding issues in AccoreConsole script paths
    const stem = path_1.default.basename(localPath, path_1.default.extname(localPath)).replace(/[^\w-]/g, "_") || "drawing";
    const ext = path_1.default.extname(localPath).toLowerCase();
    if (ext !== ".dwg") {
        throw new Error("convertDwgToOrientedPngs expects a .dwg path");
    }
    const customCmd = process.env.DOCUMIND_DWG_RASTER_CMD?.trim();
    if (customCmd) {
        await runCustomDwgRasterCommand(customCmd, localPath, tempDir);
    }
    else {
        if (!(await findAccoreConsoleBinary())) {
            throw new Error("DWG conversion requires AutoCAD Core Console (accoreconsole.exe). Install AutoCAD, set DOCUMIND_ACCORECONSOLE_PATH, " +
                "unset DOCUMIND_SKIP_ACCORECONSOLE, or set DOCUMIND_DWG_RASTER_CMD with {input} and {outdir}.");
        }
        const maxAttempts = dwgAccoreMaxAttempts();
        const delayMs = dwgAccoreRetryDelayMs();
        let accorePages = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            accorePages = await tryConvertDwgViaAccoreConsole({
                localPath,
                tempDir,
                stem,
                metadataOnly,
                accoreOpts,
            });
            if (accorePages != null) {
                return { totalSourceCount: accorePages };
            }
            if (attempt < maxAttempts) {
                console.warn(`[documind] DWG AccoreConsole attempt ${attempt}/${maxAttempts} produced no PNGs; retrying in ${delayMs}ms...`);
                await new Promise((r) => setTimeout(r, delayMs));
            }
        }
        throw new Error(`DWG conversion failed after ${maxAttempts} AccoreConsole attempt(s). Check AccoreConsole, DOCUMIND_ACCORECONSOLE_SCRIPT, ` +
            `DOCUMIND_ACCORE_LAYOUT, or use DOCUMIND_DWG_RASTER_CMD.`);
    }
    const allPngs = (await fs_extra_1.default.readdir(tempDir))
        .filter((f) => f.toLowerCase().endsWith(".png"))
        .filter((f) => isIntermediateDwgRasterPng(f))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (allPngs.length === 0) {
        throw new Error("No PNG output from DWG conversion. Check DOCUMIND_DWG_RASTER_CMD writes PNGs into {outdir}, or use AccoreConsole (default).");
    }
    let toProcess = allPngs;
    let pageIndices = allPngs.map((_, idx) => idx + 1);
    if (metadataOnly && toProcess.length > 1) {
        toProcess = [toProcess[0], toProcess[toProcess.length - 1]];
        pageIndices = [1, allPngs.length];
    }
    for (let i = 0; i < toProcess.length; i++) {
        const rawPath = path_1.default.join(tempDir, toProcess[i]);
        const buf = await fs_extra_1.default.readFile(rawPath);
        const corrected = await (0, exports.correctImageOrientation)(buf);
        const padded = pageIndices[i].toString().padStart(5, "0");
        const outPath = path_1.default.join(tempDir, `${stem}_page_${padded}.png`);
        await fs_extra_1.default.writeFile(outPath, corrected);
    }
    for (const f of allPngs) {
        await fs_extra_1.default.remove(path_1.default.join(tempDir, f)).catch(() => { });
    }
    return { totalSourceCount: allPngs.length };
}
// Convert each page (from other formats like docx) to a png and save that image to tmp
const convertFileToPdf = async ({ extension, localPath, tempDir, }) => {
    const inputBuffer = await fs_extra_1.default.readFile(localPath);
    const outputFilename = path_1.default.basename(localPath, extension) + ".pdf";
    const outputPath = path_1.default.join(tempDir, outputFilename);
    try {
        const pdfBuffer = await convertAsync(inputBuffer, ".pdf", undefined);
        await fs_extra_1.default.writeFile(outputPath, pdfBuffer);
        return outputPath;
    }
    catch (err) {
        console.error(`Error converting ${extension} to .pdf:`, err);
        throw err;
    }
};
exports.convertFileToPdf = convertFileToPdf;
const camelToSnakeCase = (str) => str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const convertKeysToSnakeCase = (obj) => {
    if (typeof obj !== "object" || obj === null) {
        return obj ?? {};
    }
    return Object.fromEntries(Object.entries(obj).map(([key, value]) => [camelToSnakeCase(key), value]));
};
exports.convertKeysToSnakeCase = convertKeysToSnakeCase;
