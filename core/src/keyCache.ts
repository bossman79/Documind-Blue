import fs from "fs-extra";
import path from "path";

function cacheDataDir(): string {
  return process.env.DOCUMIND_DATA_DIR || process.cwd();
}

const CACHE_FILE = path.join(cacheDataDir(), "documind_keys_cache.json");

/** LLM Key Proxy (port 8000): server owns locks; do not write client JSON. */
function baseUrlUsesLlmKeyProxy(): boolean {
  try {
    const raw = (process.env.BASE_URL || "").trim();
    if (!raw) return false;
    const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
    if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return false;
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return port === "8000";
  } catch {
    return false;
  }
}

export type LockType = "session" | "weekly";

/** Legacy sliding window for doc counts when Ollama sends no reset headers. */
export const OLLAMA_SESSION_QUOTA_WINDOW_MS = 4 * 60 * 60 * 1000;
/** If a session 429 has no Retry-After / reset headers, lock only this long (not a full 4h guess). */
export const OLLAMA_SESSION_LOCK_FALLBACK_MS =
  Number(process.env.OLLAMA_SESSION_LOCK_FALLBACK_MS) > 0
    ? Number(process.env.OLLAMA_SESSION_LOCK_FALLBACK_MS)
    : 20 * 60 * 1000;

/** Aligns with weekly lock / longer provider window. */
export const OLLAMA_WEEKLY_QUOTA_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

export interface KeyCacheRecord {
  exhausted: LockType;
  expiresAt: number;
}

export interface KeyCacheState {
  [keyIndex: string]: KeyCacheRecord;
}

export const getKeyCache = (): KeyCacheState => {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, "utf-8");
      return JSON.parse(data) as KeyCacheState;
    }
  } catch (err) {
    console.error("Failed to read key cache:", err);
  }
  return {};
};

/**
 * @param sessionResetAtMs - From Ollama headers (parseOllamaSessionResetAtMs). If missing, uses a short fallback lock.
 */
export const setKeyExhausted = (
  index: number,
  type: LockType,
  sessionResetAtMs?: number | null
) => {
  if (baseUrlUsesLlmKeyProxy()) return;
  const cache = getKeyCache();
  const now = Date.now();
  let expiresAt: number;
  if (type === "weekly") {
    expiresAt = now + OLLAMA_WEEKLY_QUOTA_WINDOW_MS;
  } else {
    if (sessionResetAtMs != null && sessionResetAtMs > now + 1000) {
      expiresAt = sessionResetAtMs;
    } else {
      expiresAt = now + Math.min(OLLAMA_SESSION_LOCK_FALLBACK_MS, OLLAMA_SESSION_QUOTA_WINDOW_MS);
    }
  }

  cache[index.toString()] = {
    exhausted: type,
    expiresAt,
  };

  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to write key cache:", err);
  }
};

export const clearKeyCache = () => {
  if (baseUrlUsesLlmKeyProxy()) return;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      fs.unlinkSync(CACHE_FILE);
    }
  } catch (err) {
    console.error("Failed to clear key cache:", err);
  }
};
