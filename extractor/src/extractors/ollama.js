import OpenAI from "openai";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  getOllamaKeysForBaseUrl,
  isLocalLlmApiProxy,
  ollamaKeyState,
  parseOllamaSessionResetAtMs,
  recordOllamaSessionResetHint,
  shouldRecordOllamaCloudQuota,
  withOllamaProxyModelPrefix,
} from "core";
import { logInfo, logWarn, logError, logDebug } from "../utils/crashLogger.js";

const OLLAMA_DEFAULT_URL = "http://localhost:11434";
const OLLAMA_V1_URL = "http://localhost:11434/v1";

const RETRYABLE_STATUSES = [500, 502, 503, 504];
const MAX_RETRIES_PER_KEY = Number(process.env.OLLAMA_MAX_RETRIES_PER_KEY) || 5;
const BACKOFF_BASE_MS = Number(process.env.OLLAMA_BACKOFF_BASE_MS) || 3000;
const RATE_LIMIT_COOLDOWN_MS = Number(process.env.OLLAMA_RATE_LIMIT_COOLDOWN_MS) || 90000;
const MAX_ALL_RATE_LIMITED_RETRIES = Number(process.env.OLLAMA_RATE_LIMIT_RETRIES) || 3;
/** JSON extraction via proxy / Ollama can be slow; matches core vision override pattern. */
const EXTRACT_TIMEOUT_MS =
  Number(process.env.OLLAMA_EXTRACT_TIMEOUT_MS) ||
  Number(process.env.OLLAMA_REQUEST_TIMEOUT_MS) ||
  1_200_000;

function is429(err) {
  const status = err?.response?.status ?? err?.status;
  if (status === 429) return true;
  return String(err?.message || "").includes("429");
}

function isRetryable(err) {
  if (is429(err)) return false;
  if (err?.isValidationError) return true;
  const code = err?.code;
  if (code === "ECONNABORTED" || code === "ETIMEDOUT") return true;
  const status = err?.response?.status ?? err?.status;
  if (status != null && RETRYABLE_STATUSES.includes(status)) return true;
  const msg = String(err?.message || "").toLowerCase();
  if (msg.includes("timeout") || msg.includes("econnaborted")) return true;
  return RETRYABLE_STATUSES.some((s) => msg.includes(String(s)));
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function isLocalOllama(url) {
  try {
    const u = new URL(url);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function schemaToPrompt(schema) {
  if (!schema || !Array.isArray(schema)) return { instruction: "", template: null };
  const keys = schema.map((f) => f.name);
  const template = Object.fromEntries(keys.map((k) => [k, null]));
  const lines = schema.map((f) => {
    const aliases = f.aliases && Array.isArray(f.aliases) ? f.aliases.join(", ") : "";
    const aliasNote = aliases ? ` (aliases: ${aliases})` : "";
    const enumNote = f.type === "enum" && f.values?.length ? ` Must be one of: ${f.values.join(", ")}` : "";
    return `- "${f.name}": ${f.description}${aliasNote}${enumNote}`;
  });
  const instruction = [
    "Extract ALL fields below from the document. Output a single JSON object with EXACTLY these keys.",
    "Use null for any missing value. Map document labels to keys even if worded differently (e.g. 'rev status' -> issue_status).",
    "",
    "Required keys:",
    lines.join("\n"),
    "",
    "Output format: Raw JSON only. No markdown, no ```json```, no explanation.",
  ].join("\n");
  return { instruction, template };
}

/** Build alias -> canonical name map from schema. */
function buildAliasMap(schema) {
  if (!schema || !Array.isArray(schema)) return {};
  const map = {};
  for (const f of schema) {
    if (!f.name) continue;
    map[f.name.toLowerCase()] = f.name;
    if (f.aliases && Array.isArray(f.aliases)) {
      for (const a of f.aliases) {
        if (a && typeof a === "string") map[a.toLowerCase().trim()] = f.name;
      }
    }
  }
  return map;
}

/** Normalize parsed object keys: map aliases to canonical schema names. */
function normalizeAliasKeys(obj, rawSchema) {
  if (!obj || typeof obj !== "object" || !rawSchema) return obj;
  const aliasMap = buildAliasMap(rawSchema);
  if (Object.keys(aliasMap).length === 0) return obj;
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const canonical = aliasMap[key.toLowerCase()] ?? key;
    out[canonical] = value;
  }
  return out;
}

/** Fill missing schema keys with null when model returns partial JSON. */
function fillMissingFields(obj, rawSchema) {
  if (!obj || typeof obj !== "object" || !rawSchema || !Array.isArray(rawSchema)) return obj;
  const out = { ...obj };
  for (const f of rawSchema) {
    if (f.name && !(f.name in out)) out[f.name] = null;
  }
  return out;
}

export const ollamaExtractor = async ({ markdown, zodSchema, rawSchema, prompt, model, preferredKeyIndex, keysInUse }) => {
  const extractStartTime = Date.now();
  logInfo('Ollama extraction started', {
    model,
    preferredKeyIndex,
    keysInUse: keysInUse ? [...keysInUse] : [],
    markdownLength: markdown?.length || 0,
  });

  const baseURL = process.env.BASE_URL || OLLAMA_V1_URL;
  const rootUrl = baseURL.replace(/\/v1\/?$/, "") || OLLAMA_DEFAULT_URL;
  const llmProxy = isLocalLlmApiProxy(baseURL);
  const requestModel = withOllamaProxyModelPrefix(model);
  const keysToTry = getOllamaKeysForBaseUrl(baseURL);
  if (keysToTry.length === 0) throw new Error("No Ollama API keys configured");
  
  logDebug('Ollama config', {
    baseURL,
    llmProxy,
    requestModel,
    keyCount: keysToTry.length,
  });
  const isFieldsSchema = zodSchema.shape && "fields" in zodSchema.shape;
  const { instruction: schemaInstruction, template: schemaTemplate } = rawSchema
    ? schemaToPrompt(rawSchema)
    : { instruction: "", template: null };
  const userContent = schemaInstruction
    ? `${schemaInstruction}\n\n---\n\nDocument:\n\n${markdown}`
    : markdown;

  const jsonSchema = rawSchema && !isFieldsSchema
    ? zodToJsonSchema(zodSchema, { target: "openApi3" })
    : null;

  /** Extract JSON from response that may include markdown, code blocks, or prose */
  const extractJson = (str) => {
    let s = typeof str === "string" ? str.trim() : String(str).trim();
    // Strip common prefixes (e.g. "Thinking: ..." or "Here is the JSON:")
    s = s.replace(/^(?:Thinking:|Here (?:is|'s) (?:the )?(?:extracted )?(?:data|json)[:\s]*)/i, "").trim();
    const codeBlock = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlock) s = codeBlock[1].trim();
    const firstBrace = s.indexOf("{");
    if (firstBrace === -1) return s;
    let depth = 0;
    let end = -1;
    for (let i = firstBrace; i < s.length; i++) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    return end >= 0 ? s.slice(firstBrace, end + 1) : s;
  };

  const validateResponse = (raw) => {
    const rawStr = typeof raw === "string" ? raw : String(raw);
    let parsed;
    try {
      const jsonStr = extractJson(rawStr);
      parsed = JSON.parse(jsonStr);
    } catch {
      const err = new Error(`Ollama returned invalid JSON: ${rawStr.slice(0, 200)}...`);
      err.isValidationError = true;
      throw err;
    }

    // Map alias keys to canonical schema names (e.g. "status" -> "issue_status")
    if (rawSchema && !isFieldsSchema) {
      parsed = normalizeAliasKeys(parsed, rawSchema);
      if (typeof parsed === "object" && parsed !== null) {
        for (const f of rawSchema) {
          if (f.name && f.name in parsed) {
            const val = parsed[f.name];
            if (f.type === "string" && typeof val === "number") {
              parsed[f.name] = String(val);
            } else if (f.type === "enum" && typeof val === "number") {
              parsed[f.name] = String(val);
            }
          }
        }
      }
    }

    // Find fields array (model may nest it or use different keys)
    let rawFields =
      parsed.fields ??
      parsed.schema?.fields ??
      parsed.data?.fields ??
      parsed.result?.fields ??
      (Array.isArray(parsed) ? parsed : null);
    if (!rawFields && typeof parsed === "object") {
      const arr = Object.values(parsed).find((v) => Array.isArray(v) && v.length > 0 && typeof v[0] === "object");
      if (arr) rawFields = arr;
    }
    const validTypes = ["string", "number", "array", "object"];
    const normalizeField = (f) => {
      if (typeof f !== "object" || f === null) return null;
      const name = f.name ?? f.field ?? f.key ?? (typeof f === "string" ? f : null);
      if (!name) return null;
      const type = (f.type ?? f.dataType ?? "string").toString().toLowerCase();
      const validType = validTypes.includes(type) ? type : "string";
      const out = { name: String(name), type: validType };
      if (f.description != null) out.description = String(f.description);
      if (f.children != null && Array.isArray(f.children)) {
        out.children = f.children.map(normalizeField).filter(Boolean);
      }
      return out;
    };
    if (Array.isArray(rawFields)) {
      const fields = rawFields.map(normalizeField).filter((f) => f && f.name && f.name !== "undefined");
      const normalized = { fields };
      const result = zodSchema.safeParse(normalized);
      if (result.success) return result.data;
    }

    let result = zodSchema.safeParse(parsed);
    if (result.success) {
      const filled = fillMissingFields(result.data, rawSchema);
      return filled;
    }

    // Template extraction: model may wrap payload in data/result/extraction/output
    if (!isFieldsSchema && rawSchema) {
      const candidates = [parsed.data, parsed.result, parsed.extraction, parsed.output].filter(Boolean);
      for (const cand of candidates) {
        const normalized = normalizeAliasKeys(cand, rawSchema);
        result = zodSchema.safeParse(normalized);
        if (result.success) {
          return fillMissingFields(result.data, rawSchema);
        }
      }
    }

    const err = new Error(`Ollama response did not match schema: ${result.error.message}`);
    err.isValidationError = true;
    throw err;
  };

  const documindProxyHdrs = () => {
    const h = {};
    if (preferredKeyIndex != null && preferredKeyIndex >= 0) {
      h["X-Documind-Preferred-Key-Index"] = String(preferredKeyIndex);
    }
    if (keysInUse?.size) {
      h["X-Documind-Keys-In-Use"] = [...keysInUse].sort((a, b) => a - b).join(",");
    }
    return h;
  };

  const tryWithKey = async (apiKey, keyIdx, documindExtra = {}, attempt = 0) => {
    const requestStartTime = Date.now();
    logDebug('Trying API key', { keyIdx: keyIdx + 1, documindExtra });
    
    const useBearer =
      (!isLocalOllama(baseURL) || isLocalLlmApiProxy(baseURL)) && apiKey;
    const headers = {
      "Content-Type": "application/json",
      ...(useBearer && { Authorization: `Bearer ${apiKey}` }),
      ...documindProxyHdrs(),
      ...documindExtra,
    };

    let raw = null;
    // LLM-API-Key-Proxy is OpenAI-compatible only; skip native /api/chat.
    if (jsonSchema && !isLocalLlmApiProxy(baseURL)) {
      const ac = new AbortController();
      const tid = setTimeout(() => ac.abort(), EXTRACT_TIMEOUT_MS);
      try {
        logDebug('Making /api/chat request', { keyIdx: keyIdx + 1, model: requestModel });
        const res = await fetch(`${rootUrl}/api/chat`, {
          method: "POST",
          headers,
          signal: ac.signal,
          body: JSON.stringify({
            model: requestModel,
            messages: [
              { role: "system", content: prompt },
              { role: "user", content: userContent },
            ],
            stream: false,
            format: jsonSchema,
            options: { temperature: attempt > 0 ? Math.min(0.8, attempt * 0.2) : 0 },
          }),
        });
        
        const responseTime = Date.now() - requestStartTime;
        logDebug('API response received', { 
          keyIdx: keyIdx + 1, 
          status: res.status, 
          responseTimeMs: responseTime 
        });
        
        if (!res.ok) {
          const errorText = await res.text();
          logError('API request failed', {
            keyIdx: keyIdx + 1,
            status: res.status,
            statusText: res.statusText,
            error: errorText,
            responseTimeMs: responseTime,
          });
          throw new Error(`Ollama returned ${res.status}: ${errorText}`);
        }
        
        if (shouldRecordOllamaCloudQuota()) {
          const at = parseOllamaSessionResetAtMs(res.headers);
          if (at != null) recordOllamaSessionResetHint(keyIdx, at);
        }
        const data = await res.json();
        raw =
          (data.message?.content && String(data.message.content).trim()) ||
          (data.message?.thinking && String(data.message.thinking).trim()) ||
          null;
        
        logDebug('API response parsed', { 
          keyIdx: keyIdx + 1, 
          hasContent: !!raw,
          contentLength: raw?.length || 0,
        });
      } catch (err) {
        const responseTime = Date.now() - requestStartTime;
        logError('API request exception', {
          keyIdx: keyIdx + 1,
          error: err.message,
          code: err.code,
          responseTimeMs: responseTime,
        });
        throw err;
      } finally {
        clearTimeout(tid);
      }
    }

    if (!raw) {
      const v1Url = rootUrl.replace(/\/$/, "") + (rootUrl.includes("/v1") ? "" : "/v1");
      logDebug('Falling back to OpenAI client', { keyIdx: keyIdx + 1, v1Url });
      
      const openai = new OpenAI({
        baseURL: v1Url,
        apiKey: apiKey || "ollama",
        defaultHeaders: { ...documindProxyHdrs(), ...documindExtra },
        timeout: EXTRACT_TIMEOUT_MS,
      });
      const jsonPromptSuffix = schemaInstruction
        ? `\n\n${schemaInstruction}\n\nExample: ${JSON.stringify(schemaTemplate)}`
        : "\n\nOutput ONLY valid JSON. No markdown.";
      
      try {
        const fallback = await openai.chat.completions.create({
          model: requestModel,
          messages: [{ role: "system", content: prompt + jsonPromptSuffix }, { role: "user", content: userContent }],
          response_format: { type: "json_object" },
          temperature: attempt > 0 ? Math.min(0.8, attempt * 0.2) : 0,
        });
        
        const responseTime = Date.now() - requestStartTime;
        logDebug('OpenAI client response', { 
          keyIdx: keyIdx + 1, 
          responseTimeMs: responseTime 
        });
        
        const m = fallback.choices[0]?.message;
        raw =
          (m?.content && String(m.content).trim()) ||
          (m?.thinking && String(m.thinking).trim()) ||
          null;
      } catch (err) {
        const responseTime = Date.now() - requestStartTime;
        logError('OpenAI client exception', {
          keyIdx: keyIdx + 1,
          error: err.message,
          status: err?.response?.status,
          responseTimeMs: responseTime,
        });
        throw err;
      }
    }

    if (raw != null && typeof raw === "string") {
      const t = raw.trim();
      raw = t.length > 0 ? t : null;
    }
    if (!raw) {
      const err = new Error("Ollama returned empty response");
      err.isValidationError = true;
      throw err;
    }
    return validateResponse(raw);
  };

  const errMsg = (e) => {
    if (e?.response?.data) {
      const d = e.response.data;
      return typeof d === "object" && d.error ? String(d.error) : JSON.stringify(d);
    }
    return e?.message || String(e);
  };

  let allRateLimitedRetries = 0;
  let raw = null;
  let lastErr = null;

  if (llmProxy) {
    const docComplete = { "X-Documind-Document-Complete": "1" };
    logInfo('Using LLM proxy mode', { keyCount: keysToTry.length });
    
    let attempt = 0;
    outerPx: while (true) {
      if (attempt > 0) {
        console.warn(`[Ollama extract] trying proxy key 1/${keysToTry.length} (retry ${attempt}/${MAX_RETRIES_PER_KEY})`);
      }
      try {
        raw = await tryWithKey(keysToTry[0], 0, docComplete, attempt);
        if (preferredKeyIndex != null && preferredKeyIndex >= 0) {
          ollamaKeyState.lastSuccessfulKeyIndex = preferredKeyIndex;
        }
        
        const totalTime = Date.now() - extractStartTime;
        logInfo('Extraction successful via proxy', { 
          totalTimeMs: totalTime,
          preferredKeyIndex,
        });
        break outerPx;
      } catch (err) {
        lastErr = err;
        const msg = errMsg(err);
        const status = err?.response?.status ?? err?.status;
        
        logError('Proxy extraction attempt failed', {
          error: msg,
          status,
          is429: is429(err),
          retryCount: allRateLimitedRetries,
          attempt,
        });
        
        if (is429(err)) {
          if (allRateLimitedRetries < MAX_ALL_RATE_LIMITED_RETRIES) {
            allRateLimitedRetries++;
            logWarn('Rate limited via proxy, retrying', {
              retryCount: allRateLimitedRetries,
              maxRetries: MAX_ALL_RATE_LIMITED_RETRIES,
              cooldownMs: RATE_LIMIT_COOLDOWN_MS,
            });
            console.warn(
              `[Ollama extract] 429 via LLM proxy — waiting ${Math.round(RATE_LIMIT_COOLDOWN_MS / 1000)}s before retry ${allRateLimitedRetries}/${MAX_ALL_RATE_LIMITED_RETRIES}: ${msg}`
            );
            await delay(RATE_LIMIT_COOLDOWN_MS);
            continue outerPx;
          }
          logError('Rate limit retries exhausted via proxy', { error: msg });
          console.error(`[Ollama extract] 429 via LLM proxy after retries: ${msg}`);
          throw err;
        }
        
        if (!isRetryable(err)) {
          logError('Non-retryable error via proxy', { error: msg, status });
          throw err;
        }
        
        if (attempt < MAX_RETRIES_PER_KEY) {
          const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt);
          console.warn(`[Ollama extract] Proxy key ${status || "error"} — "${msg}" — retry ${attempt + 1}/${MAX_RETRIES_PER_KEY} in ${backoffMs}ms`);
          await delay(backoffMs);
          attempt++;
          continue outerPx;
        } else {
          console.error(`[Ollama extract] Proxy key exhausted after ${MAX_RETRIES_PER_KEY} retries. Last error: ${msg}`);
          throw err;
        }
      }
    }
  } else outer: while (true) {
    const { rateLimitedKeyIndices, lastSuccessfulKeyIndex } = ollamaKeyState;
    let keysWithIdx = keysToTry
      .map((key, idx) => ({ key, idx }))
      .filter(({ idx }) => llmProxy || !rateLimitedKeyIndices.has(idx));

    if (keysWithIdx.length === 0) {
      if (allRateLimitedRetries < MAX_ALL_RATE_LIMITED_RETRIES) {
        allRateLimitedRetries++;
        console.warn(
          `[Ollama extract] all keys rate limited — waiting ${Math.round(RATE_LIMIT_COOLDOWN_MS / 1000)}s before retry ${allRateLimitedRetries}/${MAX_ALL_RATE_LIMITED_RETRIES}`
        );
        ollamaKeyState.rateLimitedKeyIndices.clear();
        await delay(RATE_LIMIT_COOLDOWN_MS);
        continue;
      }
      console.error("[Ollama extract] all keys rate limited this session");
      throw new Error("All Ollama API keys rate limited");
    }

    if (preferredKeyIndex != null && preferredKeyIndex >= 0 && preferredKeyIndex < keysToTry.length) {
    const pref = keysWithIdx.find(({ idx }) => idx === preferredKeyIndex);
    if (pref) {
      const rest = keysWithIdx.filter(({ idx }) => idx !== preferredKeyIndex);
      const restNotInUse = keysInUse ? rest.filter(({ idx }) => !keysInUse.has(idx)) : rest;
      const restInUse = keysInUse ? rest.filter(({ idx }) => keysInUse.has(idx)) : [];
      keysWithIdx = [pref, ...restNotInUse, ...restInUse];
    }
  } else if (keysInUse && keysInUse.size > 0) {
    keysWithIdx = [
      ...keysWithIdx.filter(({ idx }) => !keysInUse.has(idx)),
      ...keysWithIdx.filter(({ idx }) => keysInUse.has(idx)),
    ];
  } else {
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

  raw = null;
  lastErr = null;
  for (let i = 0; i < keysWithIdx.length; i++) {
    const { key, idx } = keysWithIdx[(startAt + i) % keysWithIdx.length];
    const keyLabel = `key ${idx + 1}/${keysToTry.length}`;
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_KEY; attempt++) {
      if (attempt > 0 || i > 0) {
        console.warn(`[Ollama extract] trying ${keyLabel}${attempt > 0 ? ` (retry ${attempt}/${MAX_RETRIES_PER_KEY})` : ""}`);
      }
      try {
        raw = await tryWithKey(key, idx, {}, attempt);
        ollamaKeyState.lastSuccessfulKeyIndex = idx;
        if (i > 0 || attempt > 0) {
          console.warn(`[Ollama extract] succeeded with ${keyLabel}`);
        }
        break;
      } catch (err) {
        lastErr = err;
        const status = err?.response?.status ?? err?.status;
        const msg = errMsg(err);
        if (is429(err)) {
          ollamaKeyState.rateLimitedKeyIndices.add(idx);
          const remaining = keysWithIdx.filter(({ idx: j }) => !ollamaKeyState.rateLimitedKeyIndices.has(j));
          if (remaining.length > 0) {
            const nextKey = keysInUse ? remaining.find(({ idx: j }) => !keysInUse.has(j)) ?? remaining[0] : remaining[0];
            console.warn(`[Ollama extract] 429 on ${keyLabel} — "${msg}" — skipping for session, using key ${nextKey.idx + 1}/${keysToTry.length}`);
            break;
          }
          if (allRateLimitedRetries < MAX_ALL_RATE_LIMITED_RETRIES) {
            allRateLimitedRetries++;
            console.warn(
              `[Ollama extract] all keys rate limited — waiting ${Math.round(RATE_LIMIT_COOLDOWN_MS / 1000)}s before retry ${allRateLimitedRetries}/${MAX_ALL_RATE_LIMITED_RETRIES}`
            );
            ollamaKeyState.rateLimitedKeyIndices.clear();
            await delay(RATE_LIMIT_COOLDOWN_MS);
            continue outer;
          }
          console.error(`[Ollama extract] 429 on ${keyLabel}, no more keys. ${msg}`);
          throw err;
        }
        if (!isRetryable(err)) {
          console.error(`[Ollama extract] ${keyLabel} failed (${status || "error"}): ${msg}`);
          throw err;
        }
        if (attempt < MAX_RETRIES_PER_KEY) {
          const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt);
          console.warn(`[Ollama extract] ${keyLabel} ${status || "error"} — "${msg}" — retry ${attempt + 1}/${MAX_RETRIES_PER_KEY} in ${backoffMs}ms`);
          await delay(backoffMs);
        } else if (i < keysWithIdx.length - 1) {
          const nextKey = keysWithIdx[(startAt + i + 1) % keysWithIdx.length];
          console.warn(`[Ollama extract] ${keyLabel} exhausted after ${MAX_RETRIES_PER_KEY} retries — failing over to key ${nextKey.idx + 1}/${keysToTry.length}`);
          break;
        } else {
          console.error(`[Ollama extract] all ${keysWithIdx.length} keys exhausted. Last error: ${msg}`);
          throw err;
        }
      }
    }
    if (raw) break outer;
  }
  }

  if (!raw) throw new Error(lastErr?.message || "Ollama returned empty response");

  return raw;
};
