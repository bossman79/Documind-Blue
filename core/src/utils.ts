import { convert } from "libreoffice-convert";
import { fromPath } from "pdf2pic";
import { PDFDocument } from "pdf-lib";
import { LLMParams } from "./types";
import { randomBytes } from "node:crypto";
import { execFile, exec } from "child_process";
import { pipeline } from "stream/promises";
import { promisify } from "util";
import * as Tesseract from "tesseract.js";
import axios from "axios";
import fs from "fs-extra";
import { OLLAMA_QUOTA_KEY_COUNT } from "./quotaUsage";
import mime from "mime-types";
import os from "os";
import path from "path";
import sharp from "sharp";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const convertAsync = promisify(convert);

const defaultLLMParams: LLMParams = {
  frequencyPenalty: 0, // OpenAI defaults to 0
  maxTokens: 4000,
  presencePenalty: 0, // OpenAI defaults to 0
  temperature: 0,
  topP: 1, // OpenAI defaults to 1
  topK: undefined, // Ollama-specific (e.g. Gemma 4 recommends 64)
};

export const validateLLMParams = (params: Partial<LLMParams>): LLMParams => {
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

/** Ollama Cloud (and some OpenAI-compatible hosts) reject data-URIs over ~10MiB. */
const DEFAULT_MAX_VISION_BASE64_CHARS = 10 * 1024 * 1024 - 2048;

export type EncodeImageForVisionOptions = {
  /** Starting max width/height before fit=inside (higher helps CAD title-block text). Default 2560, or DOCUMIND_VISION_INITIAL_LONG_SIDE. */
  initialLongSide?: number;
};

/**
 * Encode a page image for vision LLMs. Recompresses with sharp (JPEG) and downscales
 * until the base64 payload stays under the provider limit — avoids 400 on huge PNGs from pdf2pic.
 */
export const encodeImageToBase64 = async (
  imagePath: string,
  options?: EncodeImageForVisionOptions
): Promise<string> => {
  const maxB64 = (() => {
    const raw = process.env.DOCUMIND_MAX_VISION_BASE64_CHARS;
    if (raw && /^\d+$/.test(raw.trim())) return parseInt(raw.trim(), 10);
    return DEFAULT_MAX_VISION_BASE64_CHARS;
  })();

  const envLong = process.env.DOCUMIND_VISION_INITIAL_LONG_SIDE?.trim();
  const fromEnv =
    envLong && /^\d+$/.test(envLong) ? parseInt(envLong, 10) : undefined;
  let longSide =
    options?.initialLongSide ??
    fromEnv ??
    2560;

  try {
    let quality = 88;

    for (let attempt = 0; attempt < 22; attempt++) {
      const buf = await sharp(imagePath, { failOn: "truncated" })
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

    const buf = await sharp(imagePath, { failOn: "truncated" })
      .rotate()
      .resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 45, mozjpeg: true })
      .toBuffer();
    const b64 = buf.toString("base64");
    if (b64.length <= maxB64) return b64;
    throw new Error(
      `Vision image still exceeds max base64 length (${b64.length} > ${maxB64}) after recompress: ${imagePath}`
    );
  } catch (err) {
    const raw = await fs.readFile(imagePath);
    const b64 = raw.toString("base64");
    if (b64.length <= maxB64) {
      return b64;
    }
    throw new Error(
      `Could not shrink image for vision API (${imagePath}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
};

// Strip out the ```markdown wrapper
export const formatMarkdown = (text: string) => {
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
      } else {
        break;
      }
    } else {
      break;
    }
  }

  return formattedMarkdown;
};

export const isString = (value: string | null): value is string => {
  return value !== null;
};

export const isValidUrl = (string: string): boolean => {
  let url;
  try {
    url = new URL(string);
  } catch (_) {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
};

/** Shared state for Ollama key failover — core (vision) and extractor both use this so we don't retry rate-limited keys twice. */
export const ollamaKeyState = {
  lastSuccessfulKeyIndex: 0,
  rateLimitedKeyIndices: new Set<number>(),
};

/** Get Ollama API keys from env. Puts OLLAMA_API_KEY first if set, then OLLAMA_API_KEYS (comma-sep) or OLLAMA_API_KEY_2..N. */
export const getOllamaApiKeys = (): string[] => {
  const keys: string[] = [];
  const primary = process.env.OLLAMA_API_KEY?.trim();
  if (primary) keys.push(primary);

  const fromList = process.env.OLLAMA_API_KEYS;
  if (fromList && typeof fromList === "string") {
    const parts = fromList.split(",").map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
      if (p && !keys.includes(p)) keys.push(p);
    }
  } else if (keys.length <= 1) {
    for (let i = 2; i <= OLLAMA_QUOTA_KEY_COUNT; i++) {
      const extra = process.env[`OLLAMA_API_KEY_${i}`];
      if (extra && typeof extra === "string") keys.push(extra.trim());
    }
  }
  return keys.slice(0, OLLAMA_QUOTA_KEY_COUNT);
};

/** Get the number of pages in a PDF file. Returns null if the PDF is malformed and page count cannot be determined. */
export const getPdfPageCount = async (pdfPath: string): Promise<number | null> => {
  try {
    const buffer = await fs.readFile(pdfPath);
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    return doc.getPageCount();
  } catch (err) {
    console.warn(
      "Could not determine PDF page count (malformed or corrupted structure). Processing all pages.",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
};

// Save file to local tmp directory
export const downloadFile = async ({
  filePath,
  tempDir,
}: {
  filePath: string;
  tempDir: string;
}): Promise<{ extension: string; localPath: string }> => {
  // Shorten the file name by removing URL parameters
  const baseFileName = path.basename(filePath.split("?")[0]);
  const localPath = path.join(tempDir, baseFileName);
  let mimetype;

  // Check if filePath is a URL
  if (isValidUrl(filePath)) {
    const writer = fs.createWriteStream(localPath);

    const response = await axios({
      url: filePath,
      method: "GET",
      responseType: "stream",
    });

    if (response.status !== 200) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    mimetype = response.headers?.["content-type"];
    await pipeline(response.data, writer);
  } else {
    // If filePath is a local file, copy it to the temp directory
    await fs.copyFile(filePath, localPath);
  }

  if (!mimetype) {
    mimetype = mime.lookup(localPath);
  }

  let extension = mime.extension(mimetype) || "";
  if (!extension) {
    if (mimetype === "binary/octet-stream") {
      extension = ".bin";
    } else {
      throw new Error("File extension missing");
    }
  }

  if (!extension.startsWith(".")) {
    extension = `.${extension}`;
  }

  const pathExt = path.extname(localPath).toLowerCase();
  if (extension === ".bin" && pathExt === ".dwg") {
    extension = ".dwg";
  }

  return { extension, localPath };
};

// Extract text confidence from image buffer using Tesseract
export const getTextFromImage = async (
  buffer: Buffer
): Promise<{ confidence: number }> => {
  try {
    // Get image and metadata
    const image = sharp(buffer);
    const metadata = await image.metadata();

    // Crop to a 150px wide column in the center of the document.
    // This section produced the highest confidence/speed tradeoffs.
    const cropWidth = 150;
    const cropHeight = metadata.height || 0;
    const left = Math.max(0, Math.floor((metadata.width! - cropWidth) / 2));
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
      const {
        data: { confidence },
      } = await worker.recognize(croppedBuffer);
      return { confidence };
    } finally {
      await worker.terminate();
    }
  } catch (error) {
    console.error("Error during OCR:", error);
    return { confidence: 0 };
  }
};

// Correct image orientation based on OCR confidence
// Run Tesseract on 4 different orientations of the image and compare the output
export const correctImageOrientation = async (buffer: Buffer): Promise<Buffer> => {
  const image = sharp(buffer);
  const rotations = [0, 90, 180, 270];

  const results = await Promise.all(
    rotations.map(async (rotation) => {
      const rotatedImageBuffer = await image
        .clone()
        .rotate(rotation)
        .toBuffer();
      const { confidence } = await getTextFromImage(rotatedImageBuffer);
      return { rotation, confidence };
    })
  );

  // Find the rotation with the best confidence score
  const bestResult = results.reduce((best, current) =>
    current.confidence > best.confidence ? current : best
  );

  if (bestResult.rotation !== 0) {
    console.log(
      `Reorienting image ${bestResult.rotation} degrees (Confidence: ${bestResult.confidence}%).`
    );
  }

  // Rotate the image to the best orientation
  const correctedImageBuffer = await image
    .rotate(bestResult.rotation)
    .toBuffer();

  return correctedImageBuffer;
};

// Convert each page to a png, correct orientation, and save that image to tmp
export const convertPdfToImages = async ({
  localPath,
  pagesToConvertAsImages,
  tempDir,
  imageBaseName,
}: {
  localPath: string;
  pagesToConvertAsImages: number | number[];
  tempDir: string;
  /** If set, output PNGs are named `{imageBaseName}_page_XXXXX.png` instead of using the PDF basename. */
  imageBaseName?: string;
}) => {
  const options = {
    density: 300,
    format: "png",
    height: 2048,
    preserveAspectRatio: true,
    saveFilename: imageBaseName ?? path.basename(localPath, path.extname(localPath)),
    savePath: tempDir,
  };
  const storeAsImage = fromPath(localPath, options);

  try {
    const convertResults = await storeAsImage.bulk(pagesToConvertAsImages, {
      responseType: "buffer",
    });
    await Promise.all(
      convertResults.map(async (result, index) => {
        // ONLY process the first and last page
        if (index !== 0 && index !== convertResults.length - 1) return;

        if (!result || !result.buffer) {
          throw new Error("Could not convert page to image buffer");
        }
        if (!result.page) throw new Error("Could not identify page data");
        const paddedPageNumber = result.page.toString().padStart(5, "0");

        // Correct the image orientation
        const correctedBuffer = await correctImageOrientation(result.buffer);

        const imagePath = path.join(
          tempDir,
          `${options.saveFilename}_page_${paddedPageNumber}.png`
        );
        await fs.writeFile(imagePath, correctedBuffer);
      })
    );
    return convertResults;
  } catch (err) {
    console.error("Error during PDF conversion:", err);
    throw err;
  }
};

const INTERMEDIATE_DWG_PNG_REGEX = /_page_\d{5}\.png$/i;

function isIntermediateDwgRasterPng(filename: string): boolean {
  if (!filename.toLowerCase().endsWith(".png")) return false;
  return !INTERMEDIATE_DWG_PNG_REGEX.test(filename);
}

/**
 * AutoCAD Core Console (AccoreConsole.exe): headless DWG engine shipped with AutoCAD / AutoCAD LT.
 * Docs: https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-Core/files/GUID-8E54B6EC-5B52-4F62-B7FC-0D4E1EDF093A.htm
 * Example script pattern: https://gist.githubusercontent.com/erfg12/cb7d7c5ddc9b60d406f6ebbb09253dc7/raw/8178811adf09e086f29ec6aabd7882356e496f22/plotPDF.scr
 */
async function findAccoreConsoleBinary(): Promise<string | null> {
  if (process.env.DOCUMIND_SKIP_ACCORECONSOLE === "1") return null;
  const fromEnv = process.env.DOCUMIND_ACCORECONSOLE_PATH?.trim();
  if (fromEnv) {
    if (await fs.pathExists(fromEnv)) return fromEnv;
    return null;
  }
  if (process.platform !== "win32") return null;
  const roots = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"]].filter(Boolean) as string[];
  const candidates: string[] = [];
  for (const root of roots) {
    const autodesk = path.join(root, "Autodesk");
    if (!(await fs.pathExists(autodesk))) continue;
    let entries;
    try {
      entries = await fs.readdir(autodesk, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const dirName of dirs) {
      const candidate = path.join(autodesk, dirName, "accoreconsole.exe");
      if (await fs.pathExists(candidate)) candidates.push(candidate);
    }
  }
  if (candidates.length === 0) return null;
  /** DWG TrueView ships accoreconsole.exe but it often fails headless (config under Program Files, no full plot stack). Prefer full AutoCAD. */
  const nonTrueView = candidates.filter((p) => !/trueview/i.test(p));
  const pool = nonTrueView.length > 0 ? nonTrueView : candidates;
  pool.sort((a, b) =>
    path.basename(path.dirname(b)).localeCompare(path.basename(path.dirname(a)), undefined, { numeric: true })
  );
  return pool[0] ?? null;
}

/** Paths for AccoreConsole `.scr` lines: forward slashes, quoted so `C:` is not parsed as a command. */
function accoreScriptPdfPathForScr(p: string): string {
  const long = path.resolve(p);
  const fwd = long.replace(/\\/g, "/");
  return `"${fwd.replace(/"/g, '\\"')}"`;
}

/**
 * Plot-area line after `-EXPORT` `Pdf` differs by drawing/context:
 * - `[Display/Extents/Window] <Display>` — blank ⇒ Display ⇒ often "no plottable sheets" for model-heavy DWGs; use `Extents`.
 * - `[Current layout/All layouts]` — `Extents` is invalid; blank accepts Current layout.
 * When `DOCUMIND_ACCORE_EXPORT_PLOT_AREA` is set, only that value is used (trimmed; may be empty for blank).
 */
function accoreBuiltInPlotAreaStrategies(): string[] {
  const plotEnv = process.env.DOCUMIND_ACCORE_EXPORT_PLOT_AREA;
  if (plotEnv !== undefined) {
    return [plotEnv.trim()];
  }
  return ["Extents", ""];
}

function buildDefaultAccoreExportScript(pdfOutAbs: string, plotAreaLine: string): string {
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
  } else {
    lines.push("_ZOOM", "E");
  }
  
  /* Use -PLOT instead of -EXPORT for better reliability in batch processing.
   * -PLOT is more stable in AccoreConsole and handles Model space better.
   * Reference: https://gist.github.com/erfg12/cb7d7c5ddc9b60d406f6ebbb09253dc7
   */
  lines.push("_-PLOT");
  lines.push("Y");  // Detailed plot configuration? Yes
  lines.push(layout || "Model");  // Layout name or Model
  lines.push("DWG To PDF.pc3");  // Plotter name
  lines.push("");  // Paper size (blank = use default)
  lines.push("");  // Units (blank = use default)
  lines.push("");  // Orientation (blank = use default)
  lines.push("N");  // Plot upside down? No
  lines.push(plotAreaLine || "Extents");  // Plot area
  lines.push("F");  // Scale: Fit to paper
  lines.push("C");  // Center plot? Yes
  lines.push("Y");  // Plot with plot styles? Yes
  lines.push("");  // Plot style table (blank = use default)
  lines.push("Y");  // Plot with lineweights? Yes
  lines.push("N");  // Scale lineweights? No
  lines.push("Y");  // Plot paper space last? Yes
  lines.push("N");  // Hide paperspace objects? No
  lines.push(pdfQuoted);  // Output file path
  lines.push("N");  // Save changes to page setup? No
  lines.push("Y");  // Proceed with plot? Yes
  lines.push("_QUIT", "Y");
  return `${lines.join("\r\n")}\r\n`;
}

async function materializeAccoreScript(
  pdfOutAbs: string,
  tempDir: string,
  plotAreaLineForBuiltIn: string
): Promise<string> {
  const templatePath = process.env.DOCUMIND_ACCORECONSOLE_SCRIPT?.trim();
  const scrPath = path.join(tempDir, "documind_accore_export.scr");
  const pdfQuoted = accoreScriptPdfPathForScr(pdfOutAbs);
  const pdfFwd = path.resolve(pdfOutAbs).replace(/\\/g, "/");
  const pdfWin = path.resolve(pdfOutAbs);
  if (templatePath && (await fs.pathExists(templatePath))) {
    let body = await fs.readFile(templatePath, "utf8");
    body = body.replace(/\{\{OUTPUT_PDF\}\}/g, pdfQuoted);
    body = body.replace(/\{\{OUTPUT_PDF_UNQUOTED\}\}/g, pdfFwd);
    body = body.replace(/\{\{OUTPUT_PDF_WINDOWS\}\}/g, pdfWin);
    body = body.replace(/PDF_FILE_NAME_HERE/g, pdfQuoted);
    await fs.writeFile(scrPath, body, "utf8");
  } else {
    await fs.writeFile(
      scrPath,
      buildDefaultAccoreExportScript(pdfOutAbs, plotAreaLineForBuiltIn),
      "utf8"
    );
  }
  return scrPath;
}

function trimAccoreConsoleLog(text: string, maxLen = 4500): string {
  const t = text.replace(/\r\n/g, "\n").trim();
  if (!t) return "";
  return t.length <= maxLen ? t : `…(truncated)\n${t.slice(-maxLen)}`;
}

export type AccoreConversionOptions = {
  /**
   * `true` = only one Accore at a time in this Node process (batch async workers share the same gate).
   * `false` with `betweenRunsMs === 0` = multiple Accore processes may run at once (e.g. parallel batch workers).
   */
  serial: boolean;
  /**
   * After each Accore exits, wait this long before the next Accore may start **anywhere in this process**.
   * If `betweenRunsMs > 0`, Accore is always serialized globally (parallel checkbox cannot overlap Accore).
   */
  betweenRunsMs: number;
};

/**
 * Resolve Accore pacing from env, with optional per-call overrides (e.g. from GUI `process.env` at extract time).
 * Empty / missing `DOCUMIND_ACCORE_BETWEEN_RUNS_MS` defaults to 800 ms (do not use `Number("")` which is 0).
 */
export function getAccoreConversionOptions(
  override?: Partial<AccoreConversionOptions>
): AccoreConversionOptions {
  const serial =
    override?.serial !== undefined
      ? override.serial
      : process.env.DOCUMIND_ACCORE_SERIAL?.trim() !== "0";
  let betweenRunsMs: number;
  if (override?.betweenRunsMs !== undefined) {
    betweenRunsMs = Math.min(120_000, Math.max(0, Math.floor(override.betweenRunsMs)));
  } else {
    const raw = process.env.DOCUMIND_ACCORE_BETWEEN_RUNS_MS?.trim();
    if (!raw) {
      betweenRunsMs = 5000;
    } else {
      const n = parseInt(raw, 10);
      betweenRunsMs = Number.isFinite(n) && n >= 0 ? Math.min(n, 120_000) : 5000;
    }
  }
  return { serial, betweenRunsMs };
}

/** Local cache to avoid spawning PowerShell for the same path multiple times. */
const windowsPathCache = new Map<string, string>();

/**
 * Serialize Accore: mutex + mandatory pause before releasing the next waiter (pause is inside the lock).
 */
let accoreExclusiveTail: Promise<void> = Promise.resolve();

async function runAccoreExclusive<T>(work: () => Promise<T>, betweenRunsMs: number): Promise<T> {
  const prev = accoreExclusiveTail;
  let unblock!: () => void;
  accoreExclusiveTail = new Promise<void>((res) => {
    unblock = res;
  });
  await prev;
  try {
    return await work();
  } finally {
    if (betweenRunsMs > 0) {
      await new Promise<void>((r) => setTimeout(r, betweenRunsMs));
    }
    unblock();
  }
}

function buildAccoreConsoleSpawnArgs(dwgForAccore: string, scrLong: string): string[] {
  const args: string[] = [];
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

async function runAccoreConsoleDwgToPdf(
  accoreExe: string,
  dwgPath: string,
  pdfOutAbs: string,
  tempDir: string,
  plotAreaLine: string,
  accoreOpts: AccoreConversionOptions
): Promise<void> {
  const runInner = async () => {
  const dwgSourceAbs = await windowsLongAbsolutePath(
    await fs.realpath(dwgPath).catch(() => dwgPath)
  );
  /** Copy avoids Accore "file in use / read-only" when the same DWG is open in AutoCAD or the GUI. */
  let dwgForAccore = dwgSourceAbs;
  let workDwgCopy: string | null = null;
  if (process.env.DOCUMIND_ACCORE_SKIP_INPUT_COPY !== "1") {
    const ext = path.extname(dwgSourceAbs) || ".dwg";
    workDwgCopy = path.join(
      tempDir,
      `documind_accore_work_${randomBytes(8).toString("hex")}${ext}`
    );
    await fs.copy(dwgSourceAbs, workDwgCopy);
    dwgForAccore = await windowsLongAbsolutePath(workDwgCopy);
  }
  const pdfAbs = await windowsLongAbsolutePathForNewFile(pdfOutAbs);
  await fs.remove(pdfAbs).catch(() => {});
  const scrAbs = await materializeAccoreScript(pdfAbs, tempDir, plotAreaLine);
  const scrLong = await windowsLongAbsolutePath(scrAbs);
  const timeoutMs = Number(process.env.DOCUMIND_ACCORECONSOLE_TIMEOUT_MS) || 900_000;
  const accoreCwd = path.dirname(accoreExe);
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
    })) as { stdout?: string; stderr?: string };
    accoreLog = trimAccoreConsoleLog(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  } catch (err: unknown) {
    const any = err as { stdout?: string; stderr?: string; message?: string };
    accoreLog = trimAccoreConsoleLog(`${any.stdout ?? ""}\n${any.stderr ?? ""}`);
    const hint =
      accoreLog ? `\nAccoreConsole output:\n${accoreLog}` : "";
    throw new Error(
      `AccoreConsole process error: ${any.message ?? String(err)}.${hint}`
    );
  } finally {
    if (workDwgCopy) await fs.remove(workDwgCopy).catch(() => {});
  }
  if (!(await fs.pathExists(pdfAbs))) {
    const logHint = accoreLog ? `\nAccoreConsole output:\n${accoreLog}\n` : "\n";
    throw new Error(
      `AccoreConsole finished but PDF was not created at ${pdfAbs}.${logHint}` +
        "Built-in script tries plot area `Extents` then blank unless DOCUMIND_ACCORE_EXPORT_PLOT_AREA is set. " +
        "Or use DOCUMIND_ACCORECONSOLE_SCRIPT / DOCUMIND_ACCORE_LAYOUT."
    );
  }
  const st = await fs.stat(pdfAbs);
  if (st.size < 32) {
    await fs.remove(pdfAbs).catch(() => {});
    throw new Error("AccoreConsole produced an empty or invalid PDF.");
  }
  };

  // Parallel Accore only when both: serial off AND zero pause. Any non-zero pause must use one global queue
  // or async batch workers each fire Accore at full speed and the setting appears to "do nothing".
  const gateAccore = accoreOpts.serial || accoreOpts.betweenRunsMs > 0;
  if (gateAccore) {
    await runAccoreExclusive(runInner, accoreOpts.betweenRunsMs);
  } else {
    await runInner();
  }
}

async function tryConvertDwgViaAccoreConsole(params: {
  localPath: string;
  tempDir: string;
  stem: string;
  metadataOnly: boolean;
  accoreOpts: AccoreConversionOptions;
}): Promise<number | null> {
  const { localPath, tempDir, stem, metadataOnly, accoreOpts } = params;
  const accore = await findAccoreConsoleBinary();
  if (!accore) return null;
  const pdfPath = path.join(tempDir, `${stem}_documind_accore.pdf`);
  const plotStrategies = accoreBuiltInPlotAreaStrategies();
  let accorePdfOk = false;
  let lastAccoreErr: unknown = null;
  for (let si = 0; si < plotStrategies.length; si++) {
    const line = plotStrategies[si];
    const label = line === "" ? "(blank)" : JSON.stringify(line);
    try {
      await runAccoreConsoleDwgToPdf(accore, localPath, pdfPath, tempDir, line, accoreOpts);
      accorePdfOk = true;
      break;
    } catch (err) {
      lastAccoreErr = err;
      await fs.remove(pdfPath).catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      if (si < plotStrategies.length - 1) {
        console.warn(
          `[documind] AccoreConsole plot strategy ${si + 1}/${plotStrategies.length} (${label}) failed; retrying alternate… ${msg.slice(0, 500)}`
        );
      }
    }
  }
  if (!accorePdfOk) {
    console.warn(
      "[documind] AccoreConsole DWG→PDF failed (all plot strategies exhausted):",
      lastAccoreErr instanceof Error ? lastAccoreErr.message : lastAccoreErr
    );
    return null;
  }
  let pageSpec: number | number[] = -1;
  const pageCount = await getPdfPageCount(pdfPath);
  if (metadataOnly && pageCount != null && pageCount > 1) {
    pageSpec = [1, pageCount];
  }
  try {
    await convertPdfToImages({
      localPath: pdfPath,
      pagesToConvertAsImages: pageSpec,
      tempDir,
      imageBaseName: stem,
    });
  } catch (err) {
    console.warn(
      "[documind] AccoreConsole PDF→PNG failed:",
      err instanceof Error ? err.message : err
    );
    await fs.remove(pdfPath).catch(() => {});
    return null;
  }
  await fs.remove(pdfPath).catch(() => {});
  const prefix = `${stem}_page_`.toLowerCase();
  const pagePngs = (await fs.readdir(tempDir))
    .filter((f) => {
      const lower = f.toLowerCase();
      return lower.endsWith(".png") && lower.startsWith(prefix);
    })
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return pagePngs.length > 0 ? pagePngs.length : null;
}

/** Expand short paths (VGIORD~1) for Win32 tooling (e.g. AccoreConsole). */
async function windowsLongAbsolutePath(absPath: string): Promise<string> {
  if (process.platform !== "win32") return path.resolve(absPath);
  const normalized = path.resolve(absPath);
  if (windowsPathCache.has(normalized)) return windowsPathCache.get(normalized)!;

  try {
    const psLiteral = normalized.replace(/'/g, "''");
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Item -LiteralPath '${psLiteral}').FullName`],
      { windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024 }
    );
    const longP = stdout.trim();
    if (longP && /^[A-Za-z]:[\\/]/.test(longP)) {
      const result = longP.replace(/\//g, "\\");
      windowsPathCache.set(normalized, result);
      return result;
    }
  } catch {
    /* use normalized */
  }
  return normalized;
}

/** Long absolute path for a file that may not exist yet (PDF output): expand the parent directory. */
async function windowsLongAbsolutePathForNewFile(absPath: string): Promise<string> {
  if (process.platform !== "win32") return path.resolve(absPath);
  const resolved = path.resolve(absPath);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  const longDir = await windowsLongAbsolutePath(dir);
  return path.join(longDir, base);
}

async function runCustomDwgRasterCommand(
  commandTemplate: string,
  inputPath: string,
  outputDir: string
): Promise<void> {
  const cmd = commandTemplate
    .replace(/\{input\}/g, inputPath)
    .replace(/\{outdir\}/g, outputDir);
  await execAsync(cmd, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

/** Accore path: 1 initial + 2 retries by default (`DOCUMIND_DWG_CONVERSION_ATTEMPTS`, max 10). */
function dwgAccoreMaxAttempts(): number {
  const n = Number(process.env.DOCUMIND_DWG_CONVERSION_ATTEMPTS);
  if (Number.isFinite(n) && n >= 1 && n <= 10) return Math.floor(n);
  return 3;
}

function dwgAccoreRetryDelayMs(): number {
  const n = Number(process.env.DOCUMIND_DWG_RETRY_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10000;
}

/**
 * Rasterize a .dwg to PNG(s) via AccoreConsole (AutoCAD), or `DOCUMIND_DWG_RASTER_CMD` with `{input}` / `{outdir}`.
 * Retries Accore up to `DOCUMIND_DWG_CONVERSION_ATTEMPTS` times before failing.
 */
export async function convertDwgToOrientedPngs({
  localPath,
  tempDir,
  metadataOnly,
  accore,
}: {
  localPath: string;
  tempDir: string;
  metadataOnly: boolean;
  /** Resolved once per conversion; defaults from env via `getAccoreConversionOptions`. */
  accore?: Partial<AccoreConversionOptions>;
}): Promise<{ totalSourceCount: number }> {
  const accoreOpts = getAccoreConversionOptions(accore);
  // Sanitize stem to avoid encoding issues in AccoreConsole script paths
  const stem = path.basename(localPath, path.extname(localPath)).replace(/[^\w-]/g, "_") || "drawing";
  const ext = path.extname(localPath).toLowerCase();
  if (ext !== ".dwg") {
    throw new Error("convertDwgToOrientedPngs expects a .dwg path");
  }

  const customCmd = process.env.DOCUMIND_DWG_RASTER_CMD?.trim();
  if (customCmd) {
    await runCustomDwgRasterCommand(customCmd, localPath, tempDir);
  } else {
    if (!(await findAccoreConsoleBinary())) {
      throw new Error(
        "DWG conversion requires AutoCAD Core Console (accoreconsole.exe). Install AutoCAD, set DOCUMIND_ACCORECONSOLE_PATH, " +
          "unset DOCUMIND_SKIP_ACCORECONSOLE, or set DOCUMIND_DWG_RASTER_CMD with {input} and {outdir}."
      );
    }
    const maxAttempts = dwgAccoreMaxAttempts();
    const delayMs = dwgAccoreRetryDelayMs();
    let accorePages: number | null = null;
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
        console.warn(
          `[documind] DWG AccoreConsole attempt ${attempt}/${maxAttempts} produced no PNGs; retrying in ${delayMs}ms...`
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw new Error(
      `DWG conversion failed after ${maxAttempts} AccoreConsole attempt(s). Check AccoreConsole, DOCUMIND_ACCORECONSOLE_SCRIPT, ` +
        `DOCUMIND_ACCORE_LAYOUT, or use DOCUMIND_DWG_RASTER_CMD.`
    );
  }

  const allPngs = (await fs.readdir(tempDir))
    .filter((f) => f.toLowerCase().endsWith(".png"))
    .filter((f) => isIntermediateDwgRasterPng(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (allPngs.length === 0) {
    throw new Error(
      "No PNG output from DWG conversion. Check DOCUMIND_DWG_RASTER_CMD writes PNGs into {outdir}, or use AccoreConsole (default)."
    );
  }

  let toProcess = allPngs;
  let pageIndices: number[] = allPngs.map((_, idx) => idx + 1);
  if (metadataOnly && toProcess.length > 1) {
    toProcess = [toProcess[0], toProcess[toProcess.length - 1]];
    pageIndices = [1, allPngs.length];
  }

  for (let i = 0; i < toProcess.length; i++) {
    const rawPath = path.join(tempDir, toProcess[i]);
    const buf = await fs.readFile(rawPath);
    const corrected = await correctImageOrientation(buf);
    const padded = pageIndices[i].toString().padStart(5, "0");
    const outPath = path.join(tempDir, `${stem}_page_${padded}.png`);
    await fs.writeFile(outPath, corrected);
  }

  for (const f of allPngs) {
    await fs.remove(path.join(tempDir, f)).catch(() => {});
  }

  return { totalSourceCount: allPngs.length };
}

// Convert each page (from other formats like docx) to a png and save that image to tmp
export const convertFileToPdf = async ({
  extension,
  localPath,
  tempDir,
}: {
  extension: string;
  localPath: string;
  tempDir: string;
}): Promise<string> => {
  const inputBuffer = await fs.readFile(localPath);
  const outputFilename = path.basename(localPath, extension) + ".pdf";
  const outputPath = path.join(tempDir, outputFilename);

  try {
    const pdfBuffer = await convertAsync(inputBuffer, ".pdf", undefined);
    await fs.writeFile(outputPath, pdfBuffer);
    return outputPath;
  } catch (err) {
    console.error(`Error converting ${extension} to .pdf:`, err);
    throw err;
  }
};

const camelToSnakeCase = (str: string) =>
  str.replace(/[A-Z]/g, (letter: string) => `_${letter.toLowerCase()}`);

export const convertKeysToSnakeCase = (
  obj: Record<string, any> | null
): Record<string, any> => {
  if (typeof obj !== "object" || obj === null) {
    return obj ?? {};
  }

  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => [camelToSnakeCase(key), value])
  );
};
