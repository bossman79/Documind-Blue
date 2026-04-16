import { DocumindArgs, DocumindOutput } from "./types";
export { getOllamaApiKeys, ollamaKeyState } from "./utils";
export { getKeyCache, clearKeyCache, OLLAMA_SESSION_LOCK_FALLBACK_MS, } from "./keyCache";
export { getQuotaUsageSnapshot, recordOllamaKeySuccess, recordOllamaQuotaHit, recordOllamaSessionResetHint, setOllamaQuotaTrackedKeys, isOllamaQuotaKeyTracked, OLLAMA_QUOTA_KEY_COUNT, shouldRecordOllamaCloudQuota, OLLAMA_CLOUD_FREE_TIER_SESSION_DOCS_AT_FULL, OLLAMA_CLOUD_FREE_TIER_WEEKLY_DOCS_AT_REF, OLLAMA_CLOUD_FREE_TIER_WEEKLY_USED_FRACTION_AT_REF_DOCS, } from "./quotaUsage";
export { parseOllamaSessionResetAtMs } from "./ollamaSessionReset";
export { getAccoreConversionOptions } from "./utils";
export type { AccoreConversionOptions } from "./utils";
export { withOllamaProxyModelPrefix, isLocalLlmApiProxy, getOllamaKeysForBaseUrl, } from "./ollamaProxies";
export declare const documind: ({ cleanup, concurrency, filePath, llmParams, maintainFormat, metadataOnly, model, outputDir, pageDelayMs, pagesToConvertAsImages, tempDir, preferredKeyIndex, keysInUse, accoreSerial, accoreBetweenRunsMs, }: DocumindArgs) => Promise<DocumindOutput>;
