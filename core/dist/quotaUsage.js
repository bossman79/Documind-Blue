"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OLLAMA_CLOUD_FREE_TIER_WEEKLY_DOCS_AT_REF = exports.OLLAMA_CLOUD_FREE_TIER_WEEKLY_USED_FRACTION_AT_REF_DOCS = exports.OLLAMA_CLOUD_FREE_TIER_SESSION_DOCS_AT_FULL = exports.OLLAMA_QUOTA_KEY_COUNT = void 0;
exports.shouldRecordOllamaCloudQuota = shouldRecordOllamaCloudQuota;
exports.isOllamaQuotaKeyTracked = isOllamaQuotaKeyTracked;
exports.setOllamaQuotaTrackedKeys = setOllamaQuotaTrackedKeys;
exports.recordOllamaKeySuccess = recordOllamaKeySuccess;
exports.recordOllamaSessionResetHint = recordOllamaSessionResetHint;
exports.recordOllamaQuotaHit = recordOllamaQuotaHit;
exports.getQuotaUsageSnapshot = getQuotaUsageSnapshot;
const fs_extra_1 = __importDefault(require("fs-extra"));
const path_1 = __importDefault(require("path"));
const keyCache_1 = require("./keyCache");
function quotaDataDir() {
    return process.env.DOCUMIND_DATA_DIR || process.cwd();
}
const USAGE_FILE = path_1.default.join(quotaDataDir(), "documind_quota_usage.json");
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
/** True for direct Ollama Cloud only — false for local Ollama and LLM Key Proxy (proxy owns quota server-side). */
function shouldRecordOllamaCloudQuota() {
    const b = (process.env.BASE_URL || "").trim().toLowerCase();
    if (!b)
        return false;
    if (b.includes("localhost") || b.includes("127.0.0.1")) {
        return false;
    }
    return true;
}
/** Max Ollama API key slots (0-based indices 0..31). */
exports.OLLAMA_QUOTA_KEY_COUNT = 32;
/**
 * Ollama Cloud free tier (reference observation): ~106 completed document extractions in the
 * current session window lined up with ~100% session usage; the same ~106 docs in the weekly
 * window lined up with ~82.6% weekly usage. Used only as defaults before any 429-derived rolling
 * average exists (see getQuotaUsageSnapshot).
 */
exports.OLLAMA_CLOUD_FREE_TIER_SESSION_DOCS_AT_FULL = 106;
exports.OLLAMA_CLOUD_FREE_TIER_WEEKLY_USED_FRACTION_AT_REF_DOCS = 0.826;
exports.OLLAMA_CLOUD_FREE_TIER_WEEKLY_DOCS_AT_REF = 106;
function isOllamaCloudBaseUrl() {
    const b = (process.env.BASE_URL || "").trim().toLowerCase();
    return b.includes("ollama.com");
}
function ollamaCloudWeeklyDocCapReference() {
    return (exports.OLLAMA_CLOUD_FREE_TIER_WEEKLY_DOCS_AT_REF /
        exports.OLLAMA_CLOUD_FREE_TIER_WEEKLY_USED_FRACTION_AT_REF_DOCS);
}
function defaultTrackedKeys() {
    const o = {};
    for (let i = 0; i < exports.OLLAMA_QUOTA_KEY_COUNT; i++)
        o[String(i)] = true;
    return o;
}
function mergeTrackedKeys(raw) {
    const base = defaultTrackedKeys();
    if (!raw || typeof raw !== "object")
        return base;
    for (let i = 0; i < exports.OLLAMA_QUOTA_KEY_COUNT; i++) {
        const k = String(i);
        if (typeof raw[k] === "boolean")
            base[k] = raw[k];
    }
    return base;
}
const defaultState = () => ({
    avgSessionAtHit: null,
    sessionSampleCount: 0,
    avgWeeklyAtHit: null,
    weeklySampleCount: 0,
    avgSessionPagesPerDoc: null,
    avgWeeklyPagesPerDoc: null,
    keys: {},
    trackedKeys: defaultTrackedKeys(),
});
function readState() {
    try {
        if (fs_extra_1.default.existsSync(USAGE_FILE)) {
            const raw = JSON.parse(fs_extra_1.default.readFileSync(USAGE_FILE, "utf-8"));
            const base = defaultState();
            return {
                ...base,
                ...raw,
                keys: typeof raw.keys === "object" && raw.keys ? { ...raw.keys } : {},
                trackedKeys: mergeTrackedKeys(raw.trackedKeys),
            };
        }
    }
    catch (err) {
        console.error("Failed to read quota usage file:", err);
    }
    return defaultState();
}
function persist(state) {
    try {
        fs_extra_1.default.writeFileSync(USAGE_FILE, JSON.stringify(state, null, 2), "utf-8");
    }
    catch (err) {
        console.error("Failed to write quota usage file:", err);
    }
}
function keyStr(index) {
    return String(index);
}
function ensureKey(state, k) {
    if (!state.keys[k]) {
        const t = Date.now();
        state.keys[k] = {
            session: 0,
            weekly: 0,
            sessionPages: 0,
            weeklyPages: 0,
            sessionActivityAt: t,
            weeklyActivityAt: t
        };
    }
    // Migrate old data without page counts
    if (state.keys[k].sessionPages === undefined)
        state.keys[k].sessionPages = 0;
    if (state.keys[k].weeklyPages === undefined)
        state.keys[k].weeklyPages = 0;
}
/** Drop stale doc counts so a gap longer than the provider window does not inflate “current” quota. */
function reconcileKeyTimeWindows(row, now) {
    let dirty = false;
    if (row.sessionActivityAt == null || row.sessionActivityAt <= 0) {
        row.sessionActivityAt = now;
        dirty = true;
    }
    if (row.weeklyActivityAt == null || row.weeklyActivityAt <= 0) {
        row.weeklyActivityAt = now;
        dirty = true;
    }
    if (row.ollamaSessionResetAt != null && row.ollamaSessionResetAt <= now) {
        if (row.session !== 0 || row.sessionPages !== 0)
            dirty = true;
        row.session = 0;
        row.sessionPages = 0;
        row.sessionActivityAt = now;
        row.ollamaSessionResetAt = undefined;
        dirty = true;
    }
    const hasFutureOllamaSession = row.ollamaSessionResetAt != null && row.ollamaSessionResetAt > now;
    if (!hasFutureOllamaSession && now - row.sessionActivityAt > keyCache_1.OLLAMA_SESSION_QUOTA_WINDOW_MS) {
        if (row.session !== 0 || row.sessionPages !== 0)
            dirty = true;
        row.session = 0;
        row.sessionPages = 0;
        row.sessionActivityAt = now;
        dirty = true;
    }
    if (now - row.weeklyActivityAt > keyCache_1.OLLAMA_WEEKLY_QUOTA_WINDOW_MS) {
        if (row.weekly !== 0 || row.weeklyPages !== 0)
            dirty = true;
        row.weekly = 0;
        row.weeklyPages = 0;
        row.weeklyActivityAt = now;
        dirty = true;
    }
    return dirty;
}
function reconcileAllKeys(state, now) {
    let any = false;
    for (const k of Object.keys(state.keys)) {
        if (reconcileKeyTimeWindows(state.keys[k], now))
            any = true;
    }
    return any;
}
function rollingAvg(avg, n, value) {
    if (avg == null)
        return value;
    return (avg * n + value) / (n + 1);
}
function isOllamaQuotaKeyTracked(keyIndex) {
    if (keyIndex < 0 || keyIndex >= exports.OLLAMA_QUOTA_KEY_COUNT)
        return false;
    const tk = readState().trackedKeys;
    return tk[String(keyIndex)] !== false;
}
/** Which keys may update pooled session/weekly averages when they hit 429 (per-key usage counts always apply to every key). */
function setOllamaQuotaTrackedKeys(trackedMask) {
    if (baseUrlUsesLlmKeyProxy())
        return;
    if (!Array.isArray(trackedMask) || trackedMask.length !== exports.OLLAMA_QUOTA_KEY_COUNT) {
        throw new Error(`trackedMask must be a boolean[${exports.OLLAMA_QUOTA_KEY_COUNT}]`);
    }
    const state = readState();
    state.trackedKeys = {};
    for (let i = 0; i < exports.OLLAMA_QUOTA_KEY_COUNT; i++) {
        state.trackedKeys[String(i)] = !!trackedMask[i];
    }
    persist(state);
}
/**
 * One fully completed extraction (one document) on this key for Ollama Cloud / proxy.
 * Rolling averages at 429 are based on API call counts (pages), not just document counts.
 */
function recordOllamaKeySuccess(keyIndex, pageCount = 1) {
    if (baseUrlUsesLlmKeyProxy())
        return;
    const state = readState();
    const now = Date.now();
    const k = keyStr(keyIndex);
    ensureKey(state, k);
    reconcileKeyTimeWindows(state.keys[k], now);
    const row = state.keys[k];
    row.session += 1;
    row.weekly += 1;
    row.sessionPages += pageCount;
    row.weeklyPages += pageCount;
    row.sessionActivityAt = now;
    row.weeklyActivityAt = now;
    persist(state);
}
/** Store next session reset time from Ollama Cloud headers (successful or 429 responses). */
function recordOllamaSessionResetHint(keyIndex, resetAtMs) {
    if (baseUrlUsesLlmKeyProxy())
        return;
    const state = readState();
    const now = Date.now();
    if (resetAtMs <= now)
        return;
    const k = keyStr(keyIndex);
    ensureKey(state, k);
    reconcileKeyTimeWindows(state.keys[k], now);
    state.keys[k].ollamaSessionResetAt = resetAtMs;
    persist(state);
}
/** Call when a 429 marks this key exhausted; resets per-key counters; rolling averages update only for tracked keys. */
function recordOllamaQuotaHit(keyIndex, type) {
    if (baseUrlUsesLlmKeyProxy())
        return;
    const state = readState();
    const now = Date.now();
    const k = keyStr(keyIndex);
    ensureKey(state, k);
    reconcileKeyTimeWindows(state.keys[k], now);
    const row = state.keys[k];
    const tracked = isOllamaQuotaKeyTracked(keyIndex);
    if (type === "session") {
        if (tracked && row.sessionPages > 0) {
            state.avgSessionAtHit = rollingAvg(state.avgSessionAtHit, state.sessionSampleCount, row.sessionPages);
            state.sessionSampleCount += 1;
            if (row.session > 0) {
                const pagesPerDoc = row.sessionPages / row.session;
                state.avgSessionPagesPerDoc = rollingAvg(state.avgSessionPagesPerDoc, state.sessionSampleCount - 1, pagesPerDoc);
            }
        }
        row.session = 0;
        row.sessionPages = 0;
        row.sessionActivityAt = now;
    }
    else {
        if (tracked && row.weeklyPages > 0) {
            state.avgWeeklyAtHit = rollingAvg(state.avgWeeklyAtHit, state.weeklySampleCount, row.weeklyPages);
            state.weeklySampleCount += 1;
            if (row.weekly > 0) {
                const pagesPerDoc = row.weeklyPages / row.weekly;
                state.avgWeeklyPagesPerDoc = rollingAvg(state.avgWeeklyPagesPerDoc, state.weeklySampleCount - 1, pagesPerDoc);
            }
        }
        row.weekly = 0;
        row.weeklyPages = 0;
        row.session = 0;
        row.sessionPages = 0;
        row.sessionActivityAt = now;
        row.weeklyActivityAt = now;
    }
    persist(state);
}
function getQuotaUsageSnapshot() {
    const s = readState();
    const now = Date.now();
    if (reconcileAllKeys(s, now)) {
        persist(s);
    }
    const useCloudRef = isOllamaCloudBaseUrl() && shouldRecordOllamaCloudQuota();
    const refSession = exports.OLLAMA_CLOUD_FREE_TIER_SESSION_DOCS_AT_FULL;
    const refWeekly = ollamaCloudWeeklyDocCapReference();
    return {
        avgSessionAtHit: s.avgSessionAtHit != null || !useCloudRef ? s.avgSessionAtHit : refSession,
        sessionSampleCount: s.sessionSampleCount,
        avgWeeklyAtHit: s.avgWeeklyAtHit != null || !useCloudRef ? s.avgWeeklyAtHit : refWeekly,
        weeklySampleCount: s.weeklySampleCount,
        avgSessionPagesPerDoc: s.avgSessionPagesPerDoc,
        avgWeeklyPagesPerDoc: s.avgWeeklyPagesPerDoc,
        keys: { ...s.keys },
        trackedKeys: { ...mergeTrackedKeys(s.trackedKeys) },
    };
}
