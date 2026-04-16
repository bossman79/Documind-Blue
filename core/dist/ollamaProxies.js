"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOllamaProxyUrlForKeyIndex = getOllamaProxyUrlForKeyIndex;
exports.parseProxyUrlForAxios = parseProxyUrlForAxios;
exports.isLocalLlmApiProxy = isLocalLlmApiProxy;
exports.getOllamaKeysForBaseUrl = getOllamaKeysForBaseUrl;
exports.withOllamaProxyModelPrefix = withOllamaProxyModelPrefix;
const fs_extra_1 = __importDefault(require("fs-extra"));
const path_1 = __importDefault(require("path"));
const utils_1 = require("./utils");
const quotaUsage_1 = require("./quotaUsage");
const FILE_NAME = "documind_ollama_proxies.json";
function proxiesFilePath() {
    const base = process.env.DOCUMIND_DATA_DIR || process.cwd();
    return path_1.default.join(base, FILE_NAME);
}
/** Raw proxy URL for this key index (0-based), if configured in Settings. */
function getOllamaProxyUrlForKeyIndex(keyIndex) {
    if (keyIndex < 0 || keyIndex >= quotaUsage_1.OLLAMA_QUOTA_KEY_COUNT)
        return undefined;
    try {
        const fp = proxiesFilePath();
        if (!fs_extra_1.default.existsSync(fp))
            return undefined;
        const data = JSON.parse(fs_extra_1.default.readFileSync(fp, "utf-8"));
        const v = data[String(keyIndex)];
        if (typeof v !== "string")
            return undefined;
        const t = v.trim();
        return t.length ? t : undefined;
    }
    catch {
        return undefined;
    }
}
/** Parse proxy URL for axios (HTTP CONNECT to HTTPS targets). */
function parseProxyUrlForAxios(raw) {
    if (!raw || typeof raw !== "string")
        return undefined;
    const t = raw.trim();
    if (!t)
        return undefined;
    try {
        const u = new URL(t.includes("://") ? t : `http://${t}`);
        const proto = (u.protocol.replace(/:$/, "") || "http").toLowerCase();
        if (proto !== "http" && proto !== "https")
            return undefined;
        const port = u.port ? parseInt(u.port, 10) : proto === "https" ? 443 : 80;
        if (!u.hostname)
            return undefined;
        const auth = u.username !== "" || u.password !== ""
            ? {
                username: decodeURIComponent(u.username || ""),
                password: decodeURIComponent(u.password || ""),
            }
            : undefined;
        return {
            protocol: proto,
            host: u.hostname,
            port,
            ...(auth && { auth }),
        };
    }
    catch {
        return undefined;
    }
}
/**
 * True when BASE_URL targets the bundled LLM-API-Key-Proxy (default port 8000).
 * Same heuristic as gui/server.js for syncing keys to documind_synced_keys.env.
 */
function isLocalLlmApiProxy(url) {
    try {
        const u = new URL(url);
        if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1")
            return false;
        const port = u.port || (u.protocol === "https:" ? "443" : "80");
        return port === "8000";
    }
    catch {
        return false;
    }
}
/**
 * API keys to send on each HTTP request. For LLM-API-Key-Proxy, only PROXY_API_KEY
 * (OLLAMA_API_KEY) is sent; upstream Ollama Cloud keys live in the proxy, not in headers.
 */
function getOllamaKeysForBaseUrl(baseUrl) {
    if (!isLocalLlmApiProxy(baseUrl)) {
        const keys = (0, utils_1.getOllamaApiKeys)();
        return keys.length > 0 ? keys : [process.env.OLLAMA_API_KEY?.trim() || "ollama"];
    }
    const secret = process.env.OLLAMA_API_KEY?.trim();
    if (secret)
        return [secret];
    return [];
}
/**
 * LLM-API-Key-Proxy (and similar) expect `provider/model`. Set OLLAMA_PROXY_MODEL_PREFIX to the
 * slug from YOURSLUG_API_BASE (e.g. ollama_cloud for OLLAMA_CLOUD_API_BASE=...).
 */
function withOllamaProxyModelPrefix(model) {
    const raw = (process.env.OLLAMA_PROXY_MODEL_PREFIX || "").trim();
    if (!raw)
        return model;
    const prefix = raw.replace(/\/+$/, "");
    const base = model.replace(/^\/+/, "");
    return `${prefix}/${base}`;
}
