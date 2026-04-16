"use strict";
/**
 * Ollama Cloud session reset timing from response headers (Retry-After, x-ollama-*, etc.).
 * Prefer this over fixed 4h windows — the provider uses a concrete countdown.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseOllamaSessionResetAtMs = parseOllamaSessionResetAtMs;
function parseRetryAfterHeader(ra, nowMs) {
    const s = ra.trim();
    if (/^\d+$/.test(s))
        return nowMs + parseInt(s, 10) * 1000;
    const d = Date.parse(s);
    if (!Number.isNaN(d))
        return d;
    return null;
}
function headerGet(rawHeaders, name) {
    if (!rawHeaders || typeof rawHeaders !== "object")
        return null;
    const h = rawHeaders;
    if (typeof h.get === "function") {
        for (const n of [name, name.toLowerCase()]) {
            const v = h.get(n);
            if (v != null && String(v) !== "")
                return String(v);
        }
    }
    const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key != null && h[key] != null)
        return String(h[key]);
    return null;
}
/**
 * Absolute epoch ms when the current Ollama Cloud *session* quota bucket resets, or null if unknown.
 */
function parseOllamaSessionResetAtMs(rawHeaders, nowMs = Date.now()) {
    const afterNames = [
        "x-ollama-session-reset-after",
        "x-ollama-session-reset-in",
        "x-usage-session-reset-after",
        "x-session-reset-after",
        "x-ollama-reset-after",
    ];
    for (const n of afterNames) {
        const v = headerGet(rawHeaders, n);
        if (v != null) {
            const sec = parseFloat(v);
            if (!Number.isNaN(sec) && sec >= 0)
                return nowMs + sec * 1000;
        }
    }
    const ra = headerGet(rawHeaders, "retry-after");
    if (ra != null) {
        const t = parseRetryAfterHeader(ra, nowMs);
        if (t != null && t > nowMs)
            return t;
    }
    const resetNames = [
        "x-ollama-session-reset",
        "x-usage-session-reset",
        "x-ratelimit-reset",
        "ratelimit-reset",
        "x-ratelimit-reset-requests",
    ];
    for (const n of resetNames) {
        const v = headerGet(rawHeaders, n);
        if (v != null) {
            const num = parseFloat(v);
            if (!Number.isNaN(num)) {
                const ms = num < 1e12 ? num * 1000 : num;
                if (ms > nowMs)
                    return ms;
            }
        }
    }
    const isoNames = [
        "x-ollama-session-reset-at",
        "x-usage-session-reset-at",
        "x-ollama-session-reset-time",
    ];
    for (const n of isoNames) {
        const v = headerGet(rawHeaders, n);
        if (v != null) {
            const t = Date.parse(v);
            if (!Number.isNaN(t) && t > nowMs)
                return t;
        }
    }
    return null;
}
