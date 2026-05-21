import fs from "fs-extra";
import path from "path";
import type { LockType } from "./keyCache";
import { OLLAMA_SESSION_QUOTA_WINDOW_MS, OLLAMA_WEEKLY_QUOTA_WINDOW_MS } from "./keyCache";

function quotaDataDir(): string {
  return process.env.DOCUMIND_DATA_DIR || process.cwd();
}

const USAGE_FILE = path.join(quotaDataDir(), "documind_quota_usage.json");

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

/** True for direct Ollama Cloud only — false for local Ollama and LLM Key Proxy (proxy owns quota server-side). */
export function shouldRecordOllamaCloudQuota(): boolean {
  const b = (process.env.BASE_URL || "").trim().toLowerCase();
  if (!b) return false;
  if (b.includes("localhost") || b.includes("127.0.0.1")) {
    return false;
  }
  return true;
}

/** Max Ollama API key slots (0-based indices 0..39). */
export const OLLAMA_QUOTA_KEY_COUNT = 40;

/**
 * Ollama Cloud free tier (reference observation): ~106 completed document extractions in the
 * current session window lined up with ~100% session usage; the same ~106 docs in the weekly
 * window lined up with ~82.6% weekly usage. Used only as defaults before any 429-derived rolling
 * average exists (see getQuotaUsageSnapshot).
 */
export const OLLAMA_CLOUD_FREE_TIER_SESSION_DOCS_AT_FULL = 106;
export const OLLAMA_CLOUD_FREE_TIER_WEEKLY_USED_FRACTION_AT_REF_DOCS = 0.826;
export const OLLAMA_CLOUD_FREE_TIER_WEEKLY_DOCS_AT_REF = 106;

function isOllamaCloudBaseUrl(): boolean {
  const b = (process.env.BASE_URL || "").trim().toLowerCase();
  return b.includes("ollama.com");
}

function ollamaCloudWeeklyDocCapReference(): number {
  return (
    OLLAMA_CLOUD_FREE_TIER_WEEKLY_DOCS_AT_REF /
    OLLAMA_CLOUD_FREE_TIER_WEEKLY_USED_FRACTION_AT_REF_DOCS
  );
}

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

function defaultTrackedKeys(): Record<string, boolean> {
  const o: Record<string, boolean> = {};
  for (let i = 0; i < OLLAMA_QUOTA_KEY_COUNT; i++) o[String(i)] = true;
  return o;
}

function mergeTrackedKeys(raw?: Record<string, boolean>): Record<string, boolean> {
  const base = defaultTrackedKeys();
  if (!raw || typeof raw !== "object") return base;
  for (let i = 0; i < OLLAMA_QUOTA_KEY_COUNT; i++) {
    const k = String(i);
    if (typeof raw[k] === "boolean") base[k] = raw[k];
  }
  return base;
}

const defaultState = (): QuotaUsageState => ({
  avgSessionAtHit: null,
  sessionSampleCount: 0,
  avgWeeklyAtHit: null,
  weeklySampleCount: 0,
  avgSessionPagesPerDoc: null,
  avgWeeklyPagesPerDoc: null,
  keys: {},
  trackedKeys: defaultTrackedKeys(),
});

function readState(): QuotaUsageState {
  try {
    if (fs.existsSync(USAGE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(USAGE_FILE, "utf-8")) as Partial<QuotaUsageState>;
      const base = defaultState();
      return {
        ...base,
        ...raw,
        keys: typeof raw.keys === "object" && raw.keys ? { ...raw.keys } : {},
        trackedKeys: mergeTrackedKeys(raw.trackedKeys),
      };
    }
  } catch (err) {
    console.error("Failed to read quota usage file:", err);
  }
  return defaultState();
}

function persist(state: QuotaUsageState) {
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to write quota usage file:", err);
  }
}

function keyStr(index: number): string {
  return String(index);
}

function ensureKey(state: QuotaUsageState, k: string) {
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
  if (state.keys[k].sessionPages === undefined) state.keys[k].sessionPages = 0;
  if (state.keys[k].weeklyPages === undefined) state.keys[k].weeklyPages = 0;
}

/** Drop stale doc counts so a gap longer than the provider window does not inflate “current” quota. */
function reconcileKeyTimeWindows(row: KeyQuotaCounters, now: number): boolean {
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
    if (row.session !== 0 || row.sessionPages !== 0) dirty = true;
    row.session = 0;
    row.sessionPages = 0;
    row.sessionActivityAt = now;
    row.ollamaSessionResetAt = undefined;
    dirty = true;
  }
  const hasFutureOllamaSession =
    row.ollamaSessionResetAt != null && row.ollamaSessionResetAt > now;
  if (!hasFutureOllamaSession && now - row.sessionActivityAt! > OLLAMA_SESSION_QUOTA_WINDOW_MS) {
    if (row.session !== 0 || row.sessionPages !== 0) dirty = true;
    row.session = 0;
    row.sessionPages = 0;
    row.sessionActivityAt = now;
    dirty = true;
  }
  if (now - row.weeklyActivityAt! > OLLAMA_WEEKLY_QUOTA_WINDOW_MS) {
    if (row.weekly !== 0 || row.weeklyPages !== 0) dirty = true;
    row.weekly = 0;
    row.weeklyPages = 0;
    row.weeklyActivityAt = now;
    dirty = true;
  }
  return dirty;
}

function reconcileAllKeys(state: QuotaUsageState, now: number): boolean {
  let any = false;
  for (const k of Object.keys(state.keys)) {
    if (reconcileKeyTimeWindows(state.keys[k], now)) any = true;
  }
  return any;
}

function rollingAvg(avg: number | null, n: number, value: number): number {
  if (avg == null) return value;
  return (avg * n + value) / (n + 1);
}

export function isOllamaQuotaKeyTracked(keyIndex: number): boolean {
  if (keyIndex < 0 || keyIndex >= OLLAMA_QUOTA_KEY_COUNT) return false;
  const tk = readState().trackedKeys;
  return tk[String(keyIndex)] !== false;
}

/** Which keys may update pooled session/weekly averages when they hit 429 (per-key usage counts always apply to every key). */
export function setOllamaQuotaTrackedKeys(trackedMask: boolean[]): void {
  if (baseUrlUsesLlmKeyProxy()) return;
  if (!Array.isArray(trackedMask) || trackedMask.length !== OLLAMA_QUOTA_KEY_COUNT) {
    throw new Error(`trackedMask must be a boolean[${OLLAMA_QUOTA_KEY_COUNT}]`);
  }
  const state = readState();
  state.trackedKeys = {};
  for (let i = 0; i < OLLAMA_QUOTA_KEY_COUNT; i++) {
    state.trackedKeys[String(i)] = !!trackedMask[i];
  }
  persist(state);
}

/**
 * One fully completed extraction (one document) on this key for Ollama Cloud / proxy.
 * Rolling averages at 429 are based on API call counts (pages), not just document counts.
 */
export function recordOllamaKeySuccess(keyIndex: number, pageCount: number = 1): void {
  if (baseUrlUsesLlmKeyProxy()) return;
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
export function recordOllamaSessionResetHint(keyIndex: number, resetAtMs: number): void {
  if (baseUrlUsesLlmKeyProxy()) return;
  const state = readState();
  const now = Date.now();
  if (resetAtMs <= now) return;
  const k = keyStr(keyIndex);
  ensureKey(state, k);
  reconcileKeyTimeWindows(state.keys[k], now);
  state.keys[k].ollamaSessionResetAt = resetAtMs;
  persist(state);
}

/** Call when a 429 marks this key exhausted; resets per-key counters; rolling averages update only for tracked keys. */
export function recordOllamaQuotaHit(keyIndex: number, type: LockType): void {
  if (baseUrlUsesLlmKeyProxy()) return;
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
  } else {
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

export function getQuotaUsageSnapshot(): QuotaUsageState {
  const s = readState();
  const now = Date.now();
  if (reconcileAllKeys(s, now)) {
    persist(s);
  }
  const useCloudRef =
    isOllamaCloudBaseUrl() && shouldRecordOllamaCloudQuota();
  const refSession = OLLAMA_CLOUD_FREE_TIER_SESSION_DOCS_AT_FULL;
  const refWeekly = ollamaCloudWeeklyDocCapReference();
  return {
    avgSessionAtHit:
      s.avgSessionAtHit != null || !useCloudRef ? s.avgSessionAtHit : refSession,
    sessionSampleCount: s.sessionSampleCount,
    avgWeeklyAtHit:
      s.avgWeeklyAtHit != null || !useCloudRef ? s.avgWeeklyAtHit : refWeekly,
    weeklySampleCount: s.weeklySampleCount,
    avgSessionPagesPerDoc: s.avgSessionPagesPerDoc,
    avgWeeklyPagesPerDoc: s.avgWeeklyPagesPerDoc,
    keys: { ...s.keys },
    trackedKeys: { ...mergeTrackedKeys(s.trackedKeys) },
  };
}
