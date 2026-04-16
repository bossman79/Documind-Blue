/**
 * Ollama Cloud session reset timing from response headers (Retry-After, x-ollama-*, etc.).
 * Prefer this over fixed 4h windows — the provider uses a concrete countdown.
 */
/**
 * Absolute epoch ms when the current Ollama Cloud *session* quota bucket resets, or null if unknown.
 */
export declare function parseOllamaSessionResetAtMs(rawHeaders: unknown, nowMs?: number): number | null;
