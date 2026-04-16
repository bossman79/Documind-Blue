import axios, { AxiosError, type AxiosRequestConfig } from "axios";
import http from "node:http";
import https from "node:https";
import path from "path";
import { Completion } from "./utils/completion";
import { CompletionArgs, CompletionResponse } from "../types";
import { convertKeysToSnakeCase, encodeImageToBase64, ollamaKeyState } from "../utils";
import { getKeyCache, setKeyExhausted } from "../keyCache";
import { parseOllamaSessionResetAtMs } from "../ollamaSessionReset";
import { recordOllamaQuotaHit, recordOllamaSessionResetHint } from "../quotaUsage";
import {
  getOllamaKeysForBaseUrl,
  getOllamaProxyUrlForKeyIndex,
  isLocalLlmApiProxy,
  parseProxyUrlForAxios,
  withOllamaProxyModelPrefix,
} from "../ollamaProxies";
import {
  buildVisionSystemPrompt,
  CAD_VISION_INITIAL_LONG_SIDE,
} from "./utils/visionPrompt";

const RETRYABLE_STATUSES = [500, 502, 503, 504];
const MAX_RETRIES_PER_KEY = 3;
const BACKOFF_BASE_MS = 2000;
/** When all keys are rate limited: wait this long before retrying. */
const RATE_LIMIT_COOLDOWN_MS = Number(process.env.OLLAMA_RATE_LIMIT_COOLDOWN_MS) || 90000;
/** Max retries when all keys rate limited (wait + clear + retry). */
const MAX_ALL_RATE_LIMITED_RETRIES = Number(process.env.OLLAMA_RATE_LIMIT_RETRIES) || 3;
/** Vision chat/completions (large image payloads through a proxy can exceed 10 min). */
const VISION_REQUEST_TIMEOUT_MS =
  Number(process.env.DOCUMIND_VISION_TIMEOUT_MS) ||
  Number(process.env.OLLAMA_REQUEST_TIMEOUT_MS) ||
  1_800_000;

function is429(err: unknown): boolean {
  if (err instanceof AxiosError) return err.response?.status === 429;
  return String((err as Error)?.message || "").includes("429");
}

function isRetryable(err: unknown): boolean {
  if (is429(err)) return false;
  if (err instanceof AxiosError) {
    const code = err.code;
    if (code === "ECONNABORTED" || code === "ETIMEDOUT") return true;
    const status = err.response?.status;
    return status != null && RETRYABLE_STATUSES.includes(status);
  }
  const msg = String((err as Error)?.message || "").toLowerCase();
  if (msg.includes("timeout") || msg.includes("econnaborted")) return true;
  return RETRYABLE_STATUSES.some((s) => msg.includes(String(s)));
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isLocalOllama(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/** Isolated connection pools per key so cloud requests are not multiplexed through one shared agent. */
type CloudAgents = { http: http.Agent; https: https.Agent };
const cloudAgentsByKeyIndex = new Map<number, CloudAgents>();

function getCloudAgentsForKey(keyIndex: number): CloudAgents {
  let a = cloudAgentsByKeyIndex.get(keyIndex);
  if (!a) {
    a = {
      http: new http.Agent({ keepAlive: true, maxSockets: 256 }),
      https: new https.Agent({ keepAlive: true, maxSockets: 256 }),
    };
    cloudAgentsByKeyIndex.set(keyIndex, a);
  }
  return a;
}

const ACCEPT_LANG_VARIANTS = [
  "en-US,en;q=0.9",
  "en-GB,en;q=0.9",
  "en-CA,en;q=0.9",
  "en-AU,en;q=0.9",
  "en-NZ,en;q=0.9",
  "en-IE,en;q=0.9",
  "en;q=0.9",
  "en-US,en;q=0.8,es;q=0.5",
  "en-GB,en;q=0.8,fr;q=0.4",
  "en-US,en;q=0.9,de;q=0.3",
] as const;

function stableClientFingerprint(keyIndex: number): string {
  let h = 2166136261;
  const s = `documind-ollama-key-${keyIndex}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

type AxiosTransport = Pick<AxiosRequestConfig, "proxy" | "httpAgent" | "httpsAgent">;

/** Headers + axios transport so each API key uses its own TCP/TLS identity (or proxy egress) to the host. */
function buildCloudRequestProfile(
  baseUrl: string,
  apiKey: string,
  keyIndex: number
): {
  headers: Record<string, string>;
  transport: AxiosTransport;
} {
  const local = isLocalOllama(baseUrl);
  const llmProxy = isLocalLlmApiProxy(baseUrl);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if ((!local || llmProxy) && apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (local) {
    return { headers, transport: {} };
  }
  const fp = stableClientFingerprint(keyIndex);
  headers["User-Agent"] = `Documind/1.1.2 (Node.js/${process.version}; key/${keyIndex + 1}/${fp})`;
  headers["Accept-Language"] = ACCEPT_LANG_VARIANTS[keyIndex % ACCEPT_LANG_VARIANTS.length];
  const proxyUrl = getOllamaProxyUrlForKeyIndex(keyIndex);
  const proxy = parseProxyUrlForAxios(proxyUrl);
  if (proxy) {
    // Let axios handle tunneling; custom agents are not mixed with proxy.
    return { headers, transport: { proxy } };
  }
  const { http: httpAgent, https: httpsAgent } = getCloudAgentsForKey(keyIndex);
  return { headers, transport: { httpAgent, httpsAgent } };
}

/** Model name variants to try when 404 (Ollama may use different naming) */
function getModelNameVariants(model: string): string[] {
  const seen = new Set<string>([model]);
  const variants: string[] = [model];
  // e.g. qwen3.5:9b-q4_K_M -> try qwen3.5:9b, qwen3.5:9b-q4_k_m
  const match = model.match(/^(.+?):(\d+b)(-[a-zA-Z0-9_]+)?$/);
  if (match) {
    const [, base, size, quant] = match;
    if (quant) {
      const baseTag = `${base}:${size}`;
      if (!seen.has(baseTag)) { seen.add(baseTag); variants.push(baseTag); }
      const lowerQuant = quant.toLowerCase();
      const lowerFull = `${baseTag}${lowerQuant}`;
      if (lowerQuant !== quant && !seen.has(lowerFull)) { seen.add(lowerFull); variants.push(lowerFull); }
    }
  }
  return variants;
}

/** Convert OpenAI-format messages to Ollama native /api/chat format */
function toNativeOllamaMessages(messages: any[], base64Image: string): any[] {
  const native: any[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      native.push({ role: "system", content: m.content });
    } else if (m.role === "user") {
      const content = Array.isArray(m.content)
        ? m.content
            .map((p: any) =>
              p.type === "image_url" ? "" : (p.text || p.content || "")
            )
            .join("")
            .trim() || "Please convert this image to markdown."
        : String(m.content || "Please convert this image to markdown.");
      native.push({
        role: "user",
        content: content || "Please convert this image to markdown.",
        images: [base64Image],
      });
    }
  }
  return native;
}

export class Ollama implements Completion {
  public async getCompletion(args: CompletionArgs): Promise<CompletionResponse> {
    const {
      imagePath,
      llmParams,
      maintainFormat,
      model,
      priorPage,
      visionSource,
      preferredKeyIndex,
      keysInUse,
      requestIndex,
    } = args;

    const baseUrl = process.env.BASE_URL || "http://localhost:11434/v1";
    const rootUrl = baseUrl.replace(/\/v1\/?$/, "") || "http://localhost:11434";
    const llmProxy = isLocalLlmApiProxy(baseUrl);
    const trackQuotaUsage = !isLocalOllama(baseUrl) && !llmProxy;
    const keysToTry = getOllamaKeysForBaseUrl(baseUrl);
    if (keysToTry.length === 0) throw new Error("No Ollama API keys configured");

    const systemPrompt = buildVisionSystemPrompt({ visionSource });

    const messages: any = [{ role: "system", content: systemPrompt }];

    if (maintainFormat && priorPage) {
      messages.push({
        role: "system",
        content: `Please ensure markdown formatting remains consistent with the prior page:\n\n"""${priorPage}"""`,
      });
    }

    const base64Image = await encodeImageToBase64(
      imagePath,
      visionSource === "cadRaster"
        ? { initialLongSide: CAD_VISION_INITIAL_LONG_SIDE }
        : undefined
    );
    messages.push({
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${base64Image}` },
        },
      ],
    });

    const requestModel = withOllamaProxyModelPrefix(model);
    const openaiBody = {
      messages,
      model: requestModel,
      ...convertKeysToSnakeCase(llmParams ?? null),
    };

    const tryOpenAI = async (
      url: string,
      root: string,
      hdrs: Record<string, string>,
      transport: AxiosTransport = {}
    ): Promise<{ completion: CompletionResponse; headers: unknown }> => {
      const response = await axios.post(
        `${url}/chat/completions`,
        openaiBody,
        { headers: hdrs, timeout: VISION_REQUEST_TIMEOUT_MS, ...transport }
      );
      const data = response.data;
      const om = data.choices?.[0]?.message as
        | { content?: string | null; thinking?: string | null }
        | undefined;
      const oc = om?.content?.trim() || om?.thinking?.trim() || "";
      return {
        completion: {
          content: oc,
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
        },
        headers: response.headers,
      };
    };

    const tryNative = async (
      url: string,
      root: string,
      hdrs: Record<string, string>,
      transport: AxiosTransport = {}
    ): Promise<{ completion: CompletionResponse; headers: unknown }> => {
      const nativeMessages = toNativeOllamaMessages(messages, base64Image);
      const response = await axios.post(
        `${root}/api/chat`,
        {
          model: requestModel,
          messages: nativeMessages,
          stream: false,
          ...convertKeysToSnakeCase(llmParams ?? null),
        },
        { headers: hdrs, timeout: VISION_REQUEST_TIMEOUT_MS, ...transport }
      );
      const data = response.data;
      // Qwen3.5 vision bug: output often goes to thinking instead of content (ollama/ollama#14716)
      const content =
        data.message?.content?.trim() ||
        data.message?.thinking?.trim() ||
        "";
      return {
        completion: {
          content,
          inputTokens: data.eval_count ? 0 : 0,
          outputTokens: data.eval_count ?? 0,
        },
        headers: response.headers,
      };
    };

    const extractOllamaError = (e: unknown): string => {
      if (e instanceof AxiosError && e.response?.data) {
        const d = e.response.data;
        return typeof d === "object" && d.error ? String(d.error) : JSON.stringify(d);
      }
      return e instanceof Error ? e.message : String(e);
    };

    /** Hint for 404 errors: local Ollama uses /api/tags; LLM-API-Key-Proxy uses OpenAI /v1/models only. */
    const fetchInstalledModelsHint = async (
      baseUrlForList: string,
      hdrs: Record<string, string>
    ): Promise<string> => {
      const bu = baseUrlForList.replace(/\/$/, "");
      if (isLocalLlmApiProxy(baseUrlForList)) {
        try {
          const r = await axios.get(`${bu}/models`, {
            headers: hdrs,
            timeout: 3000,
          });
          const data = (r.data?.data ?? []) as { id?: string }[];
          const names = data.map((m) => m.id).filter(Boolean);
          return names.length
            ? `Proxy /v1/models: ${names.slice(0, 25).join(", ")}${names.length > 25 ? ", ..." : ""}`
            : "Proxy returned no models.";
        } catch {
          return "Could not GET /v1/models from LLM API Key Proxy (is it running on port 8000?).";
        }
      }
      const root = bu.replace(/\/v1\/?$/, "") || bu;
      try {
        const r = await axios.get(`${root}/api/tags`, {
          headers: hdrs,
          timeout: 3000,
        });
        const models = (r.data?.models ?? []) as { name?: string }[];
        const names = models.map((m) => m.name).filter(Boolean);
        return names.length ? `Installed: ${names.join(", ")}` : "No models installed.";
      } catch {
        return "Could not reach Ollama (ensure it's running).";
      }
    };

    const runWithKey = async (
      apiKey: string,
      keyIndex: number,
      extraHeaders?: Record<string, string>
    ): Promise<CompletionResponse> => {
      const { headers: baseH, transport } = buildCloudRequestProfile(baseUrl, apiKey, keyIndex);
      const headers = { ...baseH, ...(extraHeaders || {}) };
      const isLocal = isLocalOllama(baseUrl);
      const ingestSessionReset = (hdrs: unknown) => {
        if (!trackQuotaUsage) return;
        const at = parseOllamaSessionResetAtMs(hdrs);
        if (at != null && at > Date.now()) recordOllamaSessionResetHint(keyIndex, at);
      };

      let completion!: CompletionResponse;
      let respHeaders: unknown;
      if (isLocal) {
        if (llmProxy) {
          try {
            const r = await tryOpenAI(baseUrl, rootUrl, headers, transport);
            completion = r.completion;
            respHeaders = r.headers;
          } catch (err) {
            const is404 = err instanceof AxiosError && err.response?.status === 404;
            if (is404) {
              const ollamaErr = extractOllamaError(err);
              const installed = await fetchInstalledModelsHint(baseUrl, headers);
              throw new Error(
                `Ollama 404: ${ollamaErr}. ${installed} Use the exact model name from the list.`
              );
            }
            throw err;
          }
        } else {
          try {
            const r = await tryNative(baseUrl, rootUrl, headers, transport);
            completion = r.completion;
            respHeaders = r.headers;
          } catch (err) {
            const is404 = err instanceof AxiosError && err.response?.status === 404;
            if (is404) {
              try {
                const r = await tryOpenAI(baseUrl, rootUrl, headers, transport);
                completion = r.completion;
                respHeaders = r.headers;
              } catch (openaiErr) {
                const ollamaErr = extractOllamaError(err);
                const installed = await fetchInstalledModelsHint(baseUrl, headers);
                throw new Error(
                  `Ollama 404: ${ollamaErr}. ${installed} Use the exact model name from the list.`
                );
              }
            } else {
              throw err;
            }
          }
        }
      } else {
        try {
          const r = await tryOpenAI(baseUrl, rootUrl, headers, transport);
          completion = r.completion;
          respHeaders = r.headers;
        } catch (err) {
          const is404 = err instanceof AxiosError && err.response?.status === 404;
          if (is404 && baseUrl.includes("/v1")) {
            try {
              const r = await tryNative(baseUrl, rootUrl, headers, transport);
              completion = r.completion;
              respHeaders = r.headers;
            } catch (nativeErr) {
              const ollamaErr = extractOllamaError(err);
              const installed = await fetchInstalledModelsHint(baseUrl, headers);
              throw new Error(
                `Ollama 404: ${ollamaErr}. ${installed} Use exact model name. Must support vision.`
              );
            }
          } else if (is404) {
            const ollamaErr = extractOllamaError(err);
            throw new Error(`Ollama 404: ${ollamaErr}. Run \`ollama pull ${model}\` to install.`);
          } else {
            throw err;
          }
        }
      }
      ingestSessionReset(respHeaders);
      return completion;
    };

    const pageHint = path.basename(imagePath || "").replace(/\.(png|jpg|jpeg)$/i, "") || "page";
    const errMsg = (e: unknown) =>
      e instanceof AxiosError && e.response?.data
        ? (typeof e.response.data === "object" && e.response.data?.error ? String(e.response.data.error) : JSON.stringify(e.response.data))
        : e instanceof Error ? e.message : String(e);

    // Skip keys that returned 429 this session — stick with keys that work (shared with extractor)
    // When all keys rate limited: wait, clear, and retry (Ollama limits often reset after a short period)
    let allRateLimitedRetries = 0;

    let lastErr: unknown = null;

    const documindProxyOnlyHeaders = (): Record<string, string> => {
      const h: Record<string, string> = {};
      if (preferredKeyIndex != null && preferredKeyIndex >= 0) {
        h["X-Documind-Preferred-Key-Index"] = String(preferredKeyIndex);
      }
      if (keysInUse?.size) {
        h["X-Documind-Keys-In-Use"] = [...keysInUse].sort((a, b) => a - b).join(",");
      }
      return h;
    };

    /** Proxy rotates upstream keys; send routing hints only (no client-side multi-key loop). */
    if (llmProxy) {
      const px = documindProxyOnlyHeaders();
      outerPx: while (true) {
        try {
          const result = await runWithKey(keysToTry[0], 0, px);
          if (preferredKeyIndex != null && preferredKeyIndex >= 0) {
            ollamaKeyState.lastSuccessfulKeyIndex = preferredKeyIndex;
          }
          return result;
        } catch (err) {
          lastErr = err;
          const msg = errMsg(err);
          if (is429(err)) {
            if (allRateLimitedRetries < MAX_ALL_RATE_LIMITED_RETRIES) {
              allRateLimitedRetries++;
              console.warn(
                `[Ollama] ${pageHint}: 429 via LLM proxy — waiting ${Math.round(RATE_LIMIT_COOLDOWN_MS / 1000)}s before retry ${allRateLimitedRetries}/${MAX_ALL_RATE_LIMITED_RETRIES}: ${msg}`
              );
              await delay(RATE_LIMIT_COOLDOWN_MS);
              continue outerPx;
            }
            console.error(`[Ollama] ${pageHint}: 429 via LLM proxy after retries: ${msg}`);
            throw err;
          }
          throw err;
        }
      }
    }

    outer: while (true) {
      const { rateLimitedKeyIndices, lastSuccessfulKeyIndex } = ollamaKeyState;
      const cache = getKeyCache();
      const now = Date.now();
      let keysWithIdx = keysToTry
        .map((key, idx) => ({ key, idx }))
        .filter(({ idx }) => {
          if (llmProxy) return true;
          const rec = cache[idx.toString()];
          return !rec || rec.expiresAt < now;
        })
        .filter(({ idx }) => {
          if (llmProxy) return true;
          return !rateLimitedKeyIndices.has(idx);
        });

      if (keysWithIdx.length === 0) {
        const allCached =
          !llmProxy &&
          keysToTry.every((_, idx) => {
            const rec = cache[idx.toString()];
            return rec && rec.expiresAt > now;
          });
        if (allCached) {
          throw new Error("All Ollama API keys are exhausted (Session/Weekly limits reached).");
        }
        if (allRateLimitedRetries < MAX_ALL_RATE_LIMITED_RETRIES) {
          allRateLimitedRetries++;
          console.warn(
            `[Ollama] ${pageHint}: all keys rate limited — waiting ${Math.round(RATE_LIMIT_COOLDOWN_MS / 1000)}s before retry ${allRateLimitedRetries}/${MAX_ALL_RATE_LIMITED_RETRIES}`
          );
          ollamaKeyState.rateLimitedKeyIndices.clear();
          await delay(RATE_LIMIT_COOLDOWN_MS);
          continue;
        }
        console.error(`[Ollama] ${pageHint}: all keys rate limited this session`);
        throw new Error("All Ollama API keys rate limited");
      }

      // Async mode: prefer preferredKeyIndex first, then keys not in keysInUse
    // When no preferredKeyIndex: use requestIndex to round-robin across keys (distribute load)
    const effectivePreferred =
      preferredKeyIndex != null && preferredKeyIndex >= 0 && preferredKeyIndex < keysToTry.length
        ? preferredKeyIndex
        : requestIndex != null && keysWithIdx.length > 0
          ? keysWithIdx[requestIndex % keysWithIdx.length].idx
          : null;

    const shuffleArray = <T>(array: T[]): T[] => {
      const result = [...array];
      for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
      }
      return result;
    };

    if (effectivePreferred != null) {
      const pref = keysWithIdx.find(({ idx }) => idx === effectivePreferred);
      if (pref) {
        const rest = keysWithIdx.filter(({ idx }) => idx !== effectivePreferred);
        const restNotInUse = shuffleArray(keysInUse ? rest.filter(({ idx }) => !keysInUse.has(idx)) : rest);
        const restInUse = shuffleArray(keysInUse ? rest.filter(({ idx }) => keysInUse.has(idx)) : []);
        keysWithIdx = [pref, ...restNotInUse, ...restInUse];
      }
    } else if (keysInUse && keysInUse.size > 0) {
      const notInUse = shuffleArray(keysWithIdx.filter(({ idx }) => !keysInUse.has(idx)));
      const inUse = shuffleArray(keysWithIdx.filter(({ idx }) => keysInUse.has(idx)));
      keysWithIdx = [...notInUse, ...inUse];
    } else {
      // Prefer last successful key
      const startIdx = keysWithIdx.findIndex(({ idx }) => idx === lastSuccessfulKeyIndex);
      if (startIdx > 0) {
        keysWithIdx = [
          keysWithIdx[startIdx],
          ...keysWithIdx.slice(0, startIdx),
          ...keysWithIdx.slice(startIdx + 1),
        ];
      }
    }
    const startAt = 0;

    for (let i = 0; i < keysWithIdx.length; i++) {
      const { key, idx } = keysWithIdx[(startAt + i) % keysWithIdx.length];
      const keyLabel = `key ${idx + 1}/${keysToTry.length}`;
      for (let attempt = 0; attempt <= MAX_RETRIES_PER_KEY; attempt++) {
        if (attempt > 0 || i > 0) {
          console.warn(`[Ollama] ${pageHint}: trying ${keyLabel}${attempt > 0 ? ` (retry ${attempt}/${MAX_RETRIES_PER_KEY})` : ""}`);
        }
        try {
          const result = await runWithKey(key, idx);
          ollamaKeyState.lastSuccessfulKeyIndex = idx;
          if (i > 0 || attempt > 0) {
            console.warn(`[Ollama] ${pageHint}: succeeded with ${keyLabel}`);
          }
          return result;
        } catch (err) {
          lastErr = err;
          const status = err instanceof AxiosError ? err.response?.status : null;
          const msg = errMsg(err);
          if (is429(err)) {
            const isWeekly = msg.toLowerCase().includes("weekly");
            const hdrs = err instanceof AxiosError ? err.response?.headers : undefined;
            const sessionResetAt = parseOllamaSessionResetAtMs(hdrs);
            if (trackQuotaUsage) {
              recordOllamaQuotaHit(idx, isWeekly ? "weekly" : "session");
              if (!isWeekly && sessionResetAt != null) recordOllamaSessionResetHint(idx, sessionResetAt);
            }
            setKeyExhausted(idx, isWeekly ? "weekly" : "session", isWeekly ? undefined : sessionResetAt);
            ollamaKeyState.rateLimitedKeyIndices.add(idx);
            const remaining = keysWithIdx.filter(({ idx: j }) => !ollamaKeyState.rateLimitedKeyIndices.has(j));
            if (remaining.length > 0) {
              const nextKey = keysInUse ? remaining.find(({ idx: j }) => !keysInUse.has(j)) ?? remaining[0] : remaining[0];
              console.warn(`[Ollama] ${pageHint}: 429 on ${keyLabel} — "${msg}" — skipping for session, using key ${nextKey.idx + 1}/${keysToTry.length}`);
              break;
            }
            if (allRateLimitedRetries < MAX_ALL_RATE_LIMITED_RETRIES) {
              allRateLimitedRetries++;
              console.warn(
                `[Ollama] ${pageHint}: all keys rate limited — waiting ${Math.round(RATE_LIMIT_COOLDOWN_MS / 1000)}s before retry ${allRateLimitedRetries}/${MAX_ALL_RATE_LIMITED_RETRIES}`
              );
              ollamaKeyState.rateLimitedKeyIndices.clear();
              await delay(RATE_LIMIT_COOLDOWN_MS);
              continue outer;
            }
            console.error(`[Ollama] ${pageHint}: 429 on ${keyLabel}, no more keys. ${msg}`);
            throw err;
          }
          if (!isRetryable(err)) {
            console.error(`[Ollama] ${pageHint}: ${keyLabel} failed (${status || "error"}): ${msg}`);
            throw err;
          }
          if (attempt < MAX_RETRIES_PER_KEY) {
            const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt);
            console.warn(`[Ollama] ${pageHint}: ${keyLabel} ${status || "error"} — "${msg}" — retry ${attempt + 1}/${MAX_RETRIES_PER_KEY} in ${backoffMs}ms`);
            await delay(backoffMs);
          } else if (i < keysWithIdx.length - 1) {
            const nextKey = keysWithIdx[(startAt + i + 1) % keysWithIdx.length];
            console.warn(`[Ollama] ${pageHint}: ${keyLabel} exhausted after ${MAX_RETRIES_PER_KEY} retries — failing over to key ${nextKey.idx + 1}/${keysToTry.length}`);
            break;
          } else {
            console.error(`[Ollama] ${pageHint}: all ${keysWithIdx.length} keys exhausted. Last error: ${msg}`);
            throw err;
          }
        }
      }
    }
    }
    throw lastErr || new Error("Ollama request failed");
  }
}
