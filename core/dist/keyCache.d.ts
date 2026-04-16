export type LockType = "session" | "weekly";
/** Legacy sliding window for doc counts when Ollama sends no reset headers. */
export declare const OLLAMA_SESSION_QUOTA_WINDOW_MS: number;
/** If a session 429 has no Retry-After / reset headers, lock only this long (not a full 4h guess). */
export declare const OLLAMA_SESSION_LOCK_FALLBACK_MS: number;
/** Aligns with weekly lock / longer provider window. */
export declare const OLLAMA_WEEKLY_QUOTA_WINDOW_MS: number;
export interface KeyCacheRecord {
    exhausted: LockType;
    expiresAt: number;
}
export interface KeyCacheState {
    [keyIndex: string]: KeyCacheRecord;
}
export declare const getKeyCache: () => KeyCacheState;
/**
 * @param sessionResetAtMs - From Ollama headers (parseOllamaSessionResetAtMs). If missing, uses a short fallback lock.
 */
export declare const setKeyExhausted: (index: number, type: LockType, sessionResetAtMs?: number | null) => void;
export declare const clearKeyCache: () => void;
