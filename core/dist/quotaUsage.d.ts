import type { LockType } from "./keyCache";
/** True for direct Ollama Cloud only — false for local Ollama and LLM Key Proxy (proxy owns quota server-side). */
export declare function shouldRecordOllamaCloudQuota(): boolean;
/** Max Ollama API key slots (0-based indices 0..39). */
export declare const OLLAMA_QUOTA_KEY_COUNT = 40;
/**
 * Ollama Cloud free tier (reference observation): ~106 completed document extractions in the
 * current session window lined up with ~100% session usage; the same ~106 docs in the weekly
 * window lined up with ~82.6% weekly usage. Used only as defaults before any 429-derived rolling
 * average exists (see getQuotaUsageSnapshot).
 */
export declare const OLLAMA_CLOUD_FREE_TIER_SESSION_DOCS_AT_FULL = 106;
export declare const OLLAMA_CLOUD_FREE_TIER_WEEKLY_USED_FRACTION_AT_REF_DOCS = 0.826;
export declare const OLLAMA_CLOUD_FREE_TIER_WEEKLY_DOCS_AT_REF = 106;
export interface KeyQuotaCounters {
    session: number;
    weekly: number;
    /** API calls (pages) in current session window. */
    sessionPages: number;
    /** API calls (pages) in current weekly window. */
    weeklyPages: number;
    /** Last doc completion (ms); sliding session window anchor when Ollama sends no reset time. */
    sessionActivityAt?: number;
    /** Last doc completion (ms); weekly count only within WEEKLY window since this. */
    weeklyActivityAt?: number;
    /** Session quota reset instant from Ollama response headers (epoch ms). */
    ollamaSessionResetAt?: number;
}
export interface QuotaUsageState {
    avgSessionAtHit: number | null;
    sessionSampleCount: number;
    avgWeeklyAtHit: number | null;
    weeklySampleCount: number;
    /** Average pages per document at session 429 (for estimating remaining docs). */
    avgSessionPagesPerDoc: number | null;
    /** Average pages per document at weekly 429 (for estimating remaining docs). */
    avgWeeklyPagesPerDoc: number | null;
    keys: Record<string, KeyQuotaCounters>;
    /** Per key index; false = do not feed rolling averages on 429 (per-key counters still update for all keys). */
    trackedKeys: Record<string, boolean>;
}
export declare function isOllamaQuotaKeyTracked(keyIndex: number): boolean;
/** Which keys may update pooled session/weekly averages when they hit 429 (per-key usage counts always apply to every key). */
export declare function setOllamaQuotaTrackedKeys(trackedMask: boolean[]): void;
/**
 * One fully completed extraction (one document) on this key for Ollama Cloud / proxy.
 * Rolling averages at 429 are based on API call counts (pages), not just document counts.
 */
export declare function recordOllamaKeySuccess(keyIndex: number, pageCount?: number): void;
/** Store next session reset time from Ollama Cloud headers (successful or 429 responses). */
export declare function recordOllamaSessionResetHint(keyIndex: number, resetAtMs: number): void;
/** Call when a 429 marks this key exhausted; resets per-key counters; rolling averages update only for tracked keys. */
export declare function recordOllamaQuotaHit(keyIndex: number, type: LockType): void;
export declare function getQuotaUsageSnapshot(): QuotaUsageState;
