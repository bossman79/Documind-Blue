import type { AxiosProxyConfig } from "axios";
/** Raw proxy URL for this key index (0-based), if configured in Settings. */
export declare function getOllamaProxyUrlForKeyIndex(keyIndex: number): string | undefined;
/** Parse proxy URL for axios (HTTP CONNECT to HTTPS targets). */
export declare function parseProxyUrlForAxios(raw: string | undefined): AxiosProxyConfig | undefined;
/**
 * True when BASE_URL targets the bundled LLM-API-Key-Proxy (default port 8000).
 * Same heuristic as gui/server.js for syncing keys to documind_synced_keys.env.
 */
export declare function isLocalLlmApiProxy(url: string): boolean;
/**
 * API keys to send on each HTTP request. For LLM-API-Key-Proxy, only PROXY_API_KEY
 * (OLLAMA_API_KEY) is sent; upstream Ollama Cloud keys live in the proxy, not in headers.
 */
export declare function getOllamaKeysForBaseUrl(baseUrl: string): string[];
/**
 * LLM-API-Key-Proxy (and similar) expect `provider/model`. Set OLLAMA_PROXY_MODEL_PREFIX to the
 * slug from YOURSLUG_API_BASE (e.g. ollama_cloud for OLLAMA_CLOUD_API_BASE=...).
 */
export declare function withOllamaProxyModelPrefix(model: string): string;
