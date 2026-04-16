import { LLMParams } from "./types";
export declare const validateLLMParams: (params: Partial<LLMParams>) => LLMParams;
export type EncodeImageForVisionOptions = {
    /** Starting max width/height before fit=inside (higher helps CAD title-block text). Default 2560, or DOCUMIND_VISION_INITIAL_LONG_SIDE. */
    initialLongSide?: number;
};
/**
 * Encode a page image for vision LLMs. Recompresses with sharp (JPEG) and downscales
 * until the base64 payload stays under the provider limit — avoids 400 on huge PNGs from pdf2pic.
 */
export declare const encodeImageToBase64: (imagePath: string, options?: EncodeImageForVisionOptions) => Promise<string>;
export declare const formatMarkdown: (text: string) => string;
export declare const isString: (value: string | null) => value is string;
export declare const isValidUrl: (string: string) => boolean;
/** Shared state for Ollama key failover — core (vision) and extractor both use this so we don't retry rate-limited keys twice. */
export declare const ollamaKeyState: {
    lastSuccessfulKeyIndex: number;
    rateLimitedKeyIndices: Set<number>;
};
/** Get Ollama API keys from env. Puts OLLAMA_API_KEY first if set, then OLLAMA_API_KEYS (comma-sep) or OLLAMA_API_KEY_2..N. */
export declare const getOllamaApiKeys: () => string[];
/** Get the number of pages in a PDF file. Returns null if the PDF is malformed and page count cannot be determined. */
export declare const getPdfPageCount: (pdfPath: string) => Promise<number | null>;
export declare const downloadFile: ({ filePath, tempDir, }: {
    filePath: string;
    tempDir: string;
}) => Promise<{
    extension: string;
    localPath: string;
}>;
export declare const getTextFromImage: (buffer: Buffer) => Promise<{
    confidence: number;
}>;
export declare const correctImageOrientation: (buffer: Buffer) => Promise<Buffer>;
export declare const convertPdfToImages: ({ localPath, pagesToConvertAsImages, tempDir, imageBaseName, }: {
    localPath: string;
    pagesToConvertAsImages: number | number[];
    tempDir: string;
    /** If set, output PNGs are named `{imageBaseName}_page_XXXXX.png` instead of using the PDF basename. */
    imageBaseName?: string;
}) => Promise<import("pdf2pic/dist/types/convertResponse").BufferResponse[]>;
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
export declare function getAccoreConversionOptions(override?: Partial<AccoreConversionOptions>): AccoreConversionOptions;
/**
 * Rasterize a .dwg to PNG(s) via AccoreConsole (AutoCAD), or `DOCUMIND_DWG_RASTER_CMD` with `{input}` / `{outdir}`.
 * Retries Accore up to `DOCUMIND_DWG_CONVERSION_ATTEMPTS` times before failing.
 */
export declare function convertDwgToOrientedPngs({ localPath, tempDir, metadataOnly, accore, }: {
    localPath: string;
    tempDir: string;
    metadataOnly: boolean;
    /** Resolved once per conversion; defaults from env via `getAccoreConversionOptions`. */
    accore?: Partial<AccoreConversionOptions>;
}): Promise<{
    totalSourceCount: number;
}>;
export declare const convertFileToPdf: ({ extension, localPath, tempDir, }: {
    extension: string;
    localPath: string;
    tempDir: string;
}) => Promise<string>;
export declare const convertKeysToSnakeCase: (obj: Record<string, any> | null) => Record<string, any>;
