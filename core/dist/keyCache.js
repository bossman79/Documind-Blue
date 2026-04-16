"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearKeyCache = exports.setKeyExhausted = exports.getKeyCache = exports.OLLAMA_WEEKLY_QUOTA_WINDOW_MS = exports.OLLAMA_SESSION_LOCK_FALLBACK_MS = exports.OLLAMA_SESSION_QUOTA_WINDOW_MS = void 0;
const fs_extra_1 = __importDefault(require("fs-extra"));
const path_1 = __importDefault(require("path"));
function cacheDataDir() {
    return process.env.DOCUMIND_DATA_DIR || process.cwd();
}
const CACHE_FILE = path_1.default.join(cacheDataDir(), "documind_keys_cache.json");
/** LLM Key Proxy (port 8000): server owns locks; do not write client JSON. */
function baseUrlUsesLlmKeyProxy() {
    try {
        const raw = (process.env.BASE_URL || "").trim();
        if (!raw)
            return false;
        const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
        if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1")
            return false;
        const port = u.port || (u.protocol === "https:" ? "443" : "80");
        return port === "8000";
    }
    catch {
        return false;
    }
}
/** Legacy sliding window for doc counts when Ollama sends no reset headers. */
exports.OLLAMA_SESSION_QUOTA_WINDOW_MS = 4 * 60 * 60 * 1000;
/** If a session 429 has no Retry-After / reset headers, lock only this long (not a full 4h guess). */
exports.OLLAMA_SESSION_LOCK_FALLBACK_MS = Number(process.env.OLLAMA_SESSION_LOCK_FALLBACK_MS) > 0
    ? Number(process.env.OLLAMA_SESSION_LOCK_FALLBACK_MS)
    : 20 * 60 * 1000;
/** Aligns with weekly lock / longer provider window. */
exports.OLLAMA_WEEKLY_QUOTA_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
const getKeyCache = () => {
    try {
        if (fs_extra_1.default.existsSync(CACHE_FILE)) {
            const data = fs_extra_1.default.readFileSync(CACHE_FILE, "utf-8");
            return JSON.parse(data);
        }
    }
    catch (err) {
        console.error("Failed to read key cache:", err);
    }
    return {};
};
exports.getKeyCache = getKeyCache;
/**
 * @param sessionResetAtMs - From Ollama headers (parseOllamaSessionResetAtMs). If missing, uses a short fallback lock.
 */
const setKeyExhausted = (index, type, sessionResetAtMs) => {
    if (baseUrlUsesLlmKeyProxy())
        return;
    const cache = (0, exports.getKeyCache)();
    const now = Date.now();
    let expiresAt;
    if (type === "weekly") {
        expiresAt = now + exports.OLLAMA_WEEKLY_QUOTA_WINDOW_MS;
    }
    else {
        if (sessionResetAtMs != null && sessionResetAtMs > now + 1000) {
            expiresAt = sessionResetAtMs;
        }
        else {
            expiresAt = now + Math.min(exports.OLLAMA_SESSION_LOCK_FALLBACK_MS, exports.OLLAMA_SESSION_QUOTA_WINDOW_MS);
        }
    }
    cache[index.toString()] = {
        exhausted: type,
        expiresAt,
    };
    try {
        fs_extra_1.default.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
    }
    catch (err) {
        console.error("Failed to write key cache:", err);
    }
};
exports.setKeyExhausted = setKeyExhausted;
const clearKeyCache = () => {
    if (baseUrlUsesLlmKeyProxy())
        return;
    try {
        if (fs_extra_1.default.existsSync(CACHE_FILE)) {
            fs_extra_1.default.unlinkSync(CACHE_FILE);
        }
    }
    catch (err) {
        console.error("Failed to clear key cache:", err);
    }
};
exports.clearKeyCache = clearKeyCache;
