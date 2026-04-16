export declare enum OpenAIModels {
    GPT_4O = "gpt-4o",
    GPT_4O_MINI = "gpt-4o-mini"
}
export declare enum LocalModels {
    LLAMA3_2_VISION = "llama3.2-vision",
    GEMMA4_31B_CLOUD = "gemma4:31b-cloud",
    QWEN2_5_VL = "qwen2.5vl",
    QWEN2_5_VL_3B = "qwen2.5vl:3b",
    QWEN2_5_VL_7B = "qwen2.5vl:7b",
    QWEN2_5_VL_32B = "qwen2.5vl:32b",
    QWEN2_5_VL_72B = "qwen2.5vl:72b",
    QWEN3_5 = "qwen3.5",
    QWEN3_5_08B = "qwen3.5:0.8b",
    QWEN3_5_2B = "qwen3.5:2b",
    QWEN3_5_4B = "qwen3.5:4b",
    QWEN3_5_9B = "qwen3.5:9b",
    QWEN3_5_9B_Q4_K_M = "qwen3.5:9b-q4_K_M",
    QWEN3_5_27B = "qwen3.5:27b",
    QWEN3_5_35B = "qwen3.5:35b",
    QWEN3_5_122B = "qwen3.5:122b",
    QWEN3_VL = "qwen3-vl",
    QWEN3_VL_8B = "qwen3-vl:8b"
}
export declare enum GoogleModels {
    GEMINI_2_FLASH = "gemini-2.0-flash-001",
    GEMINI_2_FLASH_LITE = "gemini-2.0-flash-lite-preview-02-05",
    GEMINI_1_5_FLASH = "gemini-1.5-flash",
    GEMINI_1_5_FLASH_8B = "gemini-1.5-flash-8b",
    GEMINI_1_5_PRO = "gemini-1.5-pro"
}
export type ModelOptions = OpenAIModels | GoogleModels | LocalModels;
export interface DocumindArgs {
    cleanup?: boolean;
    concurrency?: number;
    filePath: string;
    metadataOnly?: boolean;
    pageDelayMs?: number;
    llmParams?: LLMParams;
    maintainFormat?: boolean;
    model?: ModelOptions;
    outputDir?: string;
    pagesToConvertAsImages?: number | number[];
    tempDir?: string;
    /** Async mode: prefer this key index first (0-based into OLLAMA_API_KEYS). */
    preferredKeyIndex?: number;
    /** Async mode: keys currently in use by other workers; prefer keys not in this set when failing over. */
    keysInUse?: Set<number>;
    /** When set, overrides `DOCUMIND_ACCORE_SERIAL` for this run (`false` = allow overlapping Accore). */
    accoreSerial?: boolean;
    /** When set, overrides `DOCUMIND_ACCORE_BETWEEN_RUNS_MS` (ms pause after each Accore process). */
    accoreBetweenRunsMs?: number;
}
export interface Page {
    content: string;
    contentLength: number;
    page: number;
}
export interface DocumindOutput {
    completionTime: number;
    fileName: string;
    inputTokens: number;
    outputTokens: number;
    pages: Page[];
    totalPdfPageCount?: number;
}
export interface CompletionResponse {
    content: string;
    inputTokens: number;
    outputTokens: number;
}
export interface CompletionArgs {
    imagePath: string;
    llmParams?: LLMParams;
    maintainFormat: boolean;
    model: ModelOptions;
    priorPage: string;
    /** DWG/CAD rasters: stronger vision instructions + sharper default resize for small title-block text. */
    visionSource?: "document" | "cadRaster";
    /** Async mode: prefer this key index first. */
    preferredKeyIndex?: number;
    /** Async mode: keys in use by other workers; prefer keys not in this set when failing over. */
    keysInUse?: Set<number>;
    /** When no preferredKeyIndex: use (requestIndex % numKeys) to distribute load across keys. */
    requestIndex?: number;
}
export interface LLMParams {
    frequencyPenalty?: number;
    maxTokens?: number;
    presencePenalty?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
}
