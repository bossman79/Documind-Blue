import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import { execSync, exec } from 'child_process';
import os from 'os';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// Import crash logger
const crashLoggerPath = path.join(ROOT_DIR, 'extractor/src/utils/crashLogger.js');
let batchLogger = null;
try {
  const module = await import(crashLoggerPath);
  batchLogger = module;
} catch (err) {
  console.warn('Failed to load crash logger:', err.message);
}

if (!process.env.DOCUMIND_DATA_DIR) {
  process.env.DOCUMIND_DATA_DIR = ROOT_DIR;
}

dotenv.config({ path: path.join(ROOT_DIR, '.env') });

/** Max Ollama failover keys / per-key proxy rows / quota-tracking slots (Key 1 = index 0). */
const OLLAMA_KEY_SLOT_COUNT = 32;

/** In-flight batch extract sessions — client POSTs /api/extract-batch/stop to set stopRequested. */
const activeBatchExtractSessions = new Map();

/** Documind BASE_URL points at LLM-API-Key-Proxy (port 8000). */
function isDocumindUsingLlmKeyProxy() {
  try {
    const raw = (process.env.BASE_URL || '').trim();
    if (!raw) return false;
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return false;
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return port === '8000';
  } catch {
    return false;
  }
}

function llmProxyOrigin() {
  const b = (process.env.BASE_URL || 'http://localhost:8000/v1').trim();
  const withV1 = /\/v1\/?$/i.test(b) ? b : `${b.replace(/\/$/, '')}/v1`;
  const u = new URL(withV1.includes('://') ? withV1 : `http://${withV1}`);
  return `${u.protocol}//${u.host}`;
}

async function forwardDocumindToProxy(req, res, method, proxyPath, bodyObj) {
  const origin = llmProxyOrigin();
  const secret = process.env.OLLAMA_API_KEY?.trim();
  const url = `${origin}${proxyPath}`;
  const headers = { Accept: 'application/json' };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  let body;
  if (bodyObj !== undefined && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(bodyObj);
  }
  try {
    const r = await fetch(url, { method, headers, body });
    const text = await r.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      return res.status(r.status || 502).json({ error: text || 'Invalid JSON from proxy' });
    }
    return res.status(r.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Proxy request failed' });
  }
}

const OLLAMA_PROXIES_FILE = path.join(ROOT_DIR, 'documind_ollama_proxies.json');
const LLM_PROXY_DIR = path.join(ROOT_DIR, 'LLM-API-Key-Proxy-source code');
const LLM_PROXY_SYNC_FILE = path.join(LLM_PROXY_DIR, 'documind_synced_keys.env');

/** Escape a value for a single line in a .env file */
function formatEnvKeyLine(key, value) {
  const v = String(value).replace(/\r?\n/g, '');
  if (/["#=\s]/.test(v)) {
    return `${key}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return `${key}=${v}`;
}

/**
 * Keys sent to Ollama Cloud through LLM-API-Key-Proxy (not the PROXY_API_KEY bearer).
 * When Base URL is the local proxy, OLLAMA_API_KEY is treated as the proxy secret; only
 * OLLAMA_API_KEYS (multi-key fields) are synced upstream unless that list is empty.
 */
function collectUpstreamOllamaKeysForLlmProxy() {
  const base = (process.env.BASE_URL || '').trim().toLowerCase();
  const viaLocalProxy =
    base.includes('127.0.0.1:8000') || base.includes('localhost:8000');
  const fromList = (process.env.OLLAMA_API_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  const push = (k) => {
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  if (viaLocalProxy) {
    for (const k of fromList) push(k);
    if (out.length === 0) {
      const primary = process.env.OLLAMA_API_KEY?.trim();
      if (primary) push(primary);
    }
  } else {
    const primary = process.env.OLLAMA_API_KEY?.trim();
    if (primary) push(primary);
    for (const k of fromList) push(k);
    if (out.length <= 1 && !(process.env.OLLAMA_API_KEYS || '').trim()) {
      for (let i = 2; i <= OLLAMA_KEY_SLOT_COUNT; i++) {
        const extra = process.env[`OLLAMA_API_KEY_${i}`]?.trim();
        if (extra) push(extra);
      }
    }
  }
  return out.slice(0, OLLAMA_KEY_SLOT_COUNT);
}

/** Write PREFIX_API_KEY_1..N for LLM-API-Key-Proxy from Documind env (no re-typing keys in proxy .env). */
function syncDocumindKeysToLlmProxy() {
  try {
    if (!fs.existsSync(LLM_PROXY_DIR)) return { synced: false, reason: 'no_proxy_dir' };
    const slugRaw =
      (process.env.OLLAMA_PROXY_MODEL_PREFIX || '').trim().toLowerCase() || 'ollama_cloud';
    const prefix = slugRaw
      .replace(/-/g, '_')
      .replace(/[^a-z0-9_]/g, '')
      .toUpperCase();
    if (!prefix) return { synced: false, reason: 'bad_prefix' };
    const keys = collectUpstreamOllamaKeysForLlmProxy();
    const lines = [
      '# Auto-synced from Documind (Save settings / server start). Restart the proxy window after changing keys.',
      `# model prefix / provider slug: ${slugRaw}`,
    ];
    let n = 1;
    for (const k of keys) {
      lines.push(formatEnvKeyLine(`${prefix}_API_KEY_${n}`, k));
      n++;
    }
    fs.writeFileSync(LLM_PROXY_SYNC_FILE, `${lines.join('\n')}\n`, 'utf8');
    console.log(`[llm-proxy] Synced ${keys.length} upstream key(s) → documind_synced_keys.env (${prefix}_API_KEY_*)`);
    return { synced: true, count: keys.length, prefix };
  } catch (e) {
    console.warn('[llm-proxy] sync failed:', e.message);
    return { synced: false, reason: e.message };
  }
}

function readOllamaKeyProxies() {
  const arr = Array.from({ length: OLLAMA_KEY_SLOT_COUNT }, () => '');
  try {
    if (fs.existsSync(OLLAMA_PROXIES_FILE)) {
      const o = JSON.parse(fs.readFileSync(OLLAMA_PROXIES_FILE, 'utf8'));
      for (let i = 0; i < OLLAMA_KEY_SLOT_COUNT; i++) {
        const v = o[String(i)];
        if (typeof v === 'string' && v.trim()) arr[i] = v.trim();
      }
    }
  } catch (e) {
    console.warn('readOllamaKeyProxies:', e.message);
  }
  return arr;
}

function writeOllamaKeyProxies(arr) {
  if (!Array.isArray(arr) || arr.length !== OLLAMA_KEY_SLOT_COUNT) return;
  const o = {};
  for (let i = 0; i < OLLAMA_KEY_SLOT_COUNT; i++) {
    const s = String(arr[i] ?? '').trim();
    if (s) o[String(i)] = s;
  }
  fs.writeFileSync(OLLAMA_PROXIES_FILE, JSON.stringify(o, null, 2), 'utf8');
}

const DEPS_DIR = path.join(os.homedir(), 'Downloads', 'documind-deps');
const UPLOAD_DIR = path.join(ROOT_DIR, 'gui', 'uploads');
fs.ensureDirSync(UPLOAD_DIR);

// ---------------------------------------------------------------------------
// PATH setup for portable dependencies
// ---------------------------------------------------------------------------
function findExecutable(baseDir, exeName) {
  if (!fs.existsSync(baseDir)) return null;
  const search = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = search(full);
        if (found) return found;
      } else if (entry.name.toLowerCase() === exeName.toLowerCase()) {
        return full;
      }
    }
    return null;
  };
  return search(baseDir);
}

function addDepsToPath() {
  const gsDir = path.join(DEPS_DIR, 'ghostscript');
  const gmDirs = [
    path.join(ROOT_DIR, 'GM'),                    // project folder (user-added)
    path.join(DEPS_DIR, 'graphicsmagick'),
  ];

  const gsExe = findExecutable(gsDir, 'gswin64c.exe') || findExecutable(gsDir, 'gswin64.exe');
  if (gsExe) {
    const gsBin = path.dirname(gsExe);
    if (!process.env.Path.includes(gsBin)) {
      process.env.Path = gsBin + ';' + process.env.Path;
    }

    // GraphicsMagick on Windows needs @PSDelegate@ resolved - create patched delegates.mgk
    const gmConfigDir = path.join(ROOT_DIR, 'gui', 'gm-config');
    const delegatesSrc = path.join(ROOT_DIR, 'GM', 'delegates.mgk');
    const delegatesDst = path.join(gmConfigDir, 'delegates.mgk');
    if (fs.existsSync(delegatesSrc) && fs.existsSync(path.join(ROOT_DIR, 'GM', 'gm.exe'))) {
      try {
        fs.ensureDirSync(gmConfigDir);
        let content = fs.readFileSync(delegatesSrc, 'utf8');
        const gsPath = gsExe.replace(/\\/g, '/');
        content = content.replace(/@PSDelegate@/g, gsPath);
        fs.writeFileSync(delegatesDst, content);
        process.env.MAGICK_CONFIGURE_PATH = gmConfigDir;
      } catch (err) {
        console.warn('Could not create GM delegates config:', err.message);
      }
    }
  }

  for (const gmDir of gmDirs) {
    const gmExe = findExecutable(gmDir, 'gm.exe');
    if (gmExe) {
      const gmBin = path.dirname(gmExe);
      if (!process.env.Path.includes(gmBin)) {
        process.env.Path = gmBin + ';' + process.env.Path;
      }
      break;
    }
  }
}

addDepsToPath();

// ---------------------------------------------------------------------------
// Dependency checking
// ---------------------------------------------------------------------------
function checkDependency(name) {
  const checks = {
    ghostscript: () => {
      try {
        execSync('gswin64c -v', { stdio: 'pipe', timeout: 5000 });
        return true;
      } catch {
        try {
          execSync('gs -v', { stdio: 'pipe', timeout: 5000 });
          return true;
        } catch {
          return false;
        }
      }
    },
    graphicsmagick: () => {
      try {
        execSync('gm version', { stdio: 'pipe', timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    },
    node: () => true,
  };
  return (checks[name] || (() => false))();
}

function getAllDepsStatus() {
  return {
    ghostscript: checkDependency('ghostscript'),
    graphicsmagick: checkDependency('graphicsmagick'),
    node: true,
  };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 500 * 1024 * 1024 },
});

/** Batch uploads: accept any file field name (browsers/tools vary; strict fields caused MulterError) */
const uploadBatch = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 500 * 1024 * 1024,
  },
}).any();

function getBatchUploadedFiles(req) {
  return Array.isArray(req.files) ? req.files : [];
}

async function deleteSourceFilesIfEnabled(filePaths) {
  if (process.env.DOCUMIND_DELETE_AFTER_EXTRACT !== '1') {
    return { deleted: 0, errors: [] };
  }
  
  let trash;
  let useTrash = true;
  try {
    trash = (await import('trash')).default;
  } catch (err) {
    console.warn('[deleteSourceFiles] trash module not available, using fs.remove fallback:', err.message);
    useTrash = false;
  }

  const deleted = [];
  const errors = [];
  
  for (const filePath of filePaths) {
    if (!filePath || !path.isAbsolute(filePath)) {
      continue;
    }
    
    try {
      if (fs.existsSync(filePath)) {
        if (useTrash) {
          await trash(filePath);
          console.log(`[deleteSourceFiles] Moved to recycle bin: ${filePath}`);
        } else {
          await fs.remove(filePath);
          console.log(`[deleteSourceFiles] Permanently deleted: ${filePath}`);
        }
        deleted.push(filePath);
      }
    } catch (err) {
      console.error(`[deleteSourceFiles] Failed to delete ${filePath}:`, err.message);
      errors.push({ file: filePath, error: err.message });
    }
  }
  
  return { deleted: deleted.length, errors };
}

// -- Status / deps ----------------------------------------------------------
app.get('/api/status', (req, res) => {
  const deps = getAllDepsStatus();
  const envKeys = {
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
    BASE_URL: process.env.BASE_URL || '',
    OLLAMA_API_KEYS: process.env.OLLAMA_API_KEYS || '',
    OLLAMA_API_KEY: !!process.env.OLLAMA_API_KEY,
  };
  res.json({ deps, envKeys });
});

app.post('/api/install-deps', async (req, res) => {
  try {
    const pythonScript = path.join(ROOT_DIR, 'install_deps.py');
    if (!fs.existsSync(pythonScript)) {
      return res.status(400).json({ error: 'install_deps.py not found' });
    }

    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const child = exec(`${pythonCmd} "${pythonScript}"`, { cwd: ROOT_DIR, timeout: 300000 });
    let output = '';
    child.stdout.on('data', d => output += d);
    child.stderr.on('data', d => output += d);
    child.on('close', (code) => {
      addDepsToPath();
      const deps = getAllDepsStatus();
      res.json({ success: code === 0, output, deps });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- Settings ---------------------------------------------------------------
app.post('/api/settings', async (req, res) => {
  try {
    const {
      OPENAI_API_KEY,
      GEMINI_API_KEY,
      BASE_URL,
      OLLAMA_API_KEYS,
      OLLAMA_API_KEY,
      OLLAMA_PROXY_MODEL_PREFIX,
      ollamaKeyProxies,
      DOCUMIND_ACCORE_SERIAL,
      DOCUMIND_ACCORE_BETWEEN_RUNS_MS,
      DOCUMIND_DELETE_AFTER_EXTRACT,
      DOCUMIND_SOURCE_FOLDER,
    } = req.body;
    const envPath = path.join(ROOT_DIR, '.env');

    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    const setEnvVar = (content, key, value) => {
      if (value === undefined || value === null) return content;
      const regex = new RegExp(`^${key}=.*$`, 'm');
      const line = `${key}=${value}`;
      if (regex.test(content)) {
        return content.replace(regex, line);
      }
      return content + (content.endsWith('\n') || content === '' ? '' : '\n') + line + '\n';
    };

    envContent = setEnvVar(envContent, 'OPENAI_API_KEY', OPENAI_API_KEY);
    envContent = setEnvVar(envContent, 'GEMINI_API_KEY', GEMINI_API_KEY);
    envContent = setEnvVar(envContent, 'BASE_URL', BASE_URL);
    envContent = setEnvVar(envContent, 'OLLAMA_API_KEYS', OLLAMA_API_KEYS);
    envContent = setEnvVar(envContent, 'OLLAMA_API_KEY', OLLAMA_API_KEY);
    envContent = setEnvVar(envContent, 'OLLAMA_PROXY_MODEL_PREFIX', OLLAMA_PROXY_MODEL_PREFIX);
    if (DOCUMIND_ACCORE_SERIAL !== undefined && DOCUMIND_ACCORE_SERIAL !== null) {
      envContent = setEnvVar(envContent, 'DOCUMIND_ACCORE_SERIAL', String(DOCUMIND_ACCORE_SERIAL).trim());
    }
    if (DOCUMIND_ACCORE_BETWEEN_RUNS_MS !== undefined && DOCUMIND_ACCORE_BETWEEN_RUNS_MS !== null) {
      const ms = String(DOCUMIND_ACCORE_BETWEEN_RUNS_MS).trim();
      envContent = setEnvVar(envContent, 'DOCUMIND_ACCORE_BETWEEN_RUNS_MS', ms);
    }
    if (DOCUMIND_DELETE_AFTER_EXTRACT !== undefined && DOCUMIND_DELETE_AFTER_EXTRACT !== null) {
      envContent = setEnvVar(envContent, 'DOCUMIND_DELETE_AFTER_EXTRACT', String(DOCUMIND_DELETE_AFTER_EXTRACT).trim());
    }
    if (DOCUMIND_SOURCE_FOLDER !== undefined && DOCUMIND_SOURCE_FOLDER !== null) {
      envContent = setEnvVar(envContent, 'DOCUMIND_SOURCE_FOLDER', String(DOCUMIND_SOURCE_FOLDER).trim());
    }

    fs.writeFileSync(envPath, envContent);

    if (Array.isArray(ollamaKeyProxies) && ollamaKeyProxies.length === OLLAMA_KEY_SLOT_COUNT) {
      writeOllamaKeyProxies(ollamaKeyProxies);
    }

    if (OPENAI_API_KEY !== undefined) process.env.OPENAI_API_KEY = OPENAI_API_KEY;
    if (GEMINI_API_KEY !== undefined) process.env.GEMINI_API_KEY = GEMINI_API_KEY;
    if (BASE_URL !== undefined) process.env.BASE_URL = BASE_URL;
    if (OLLAMA_API_KEYS !== undefined) process.env.OLLAMA_API_KEYS = OLLAMA_API_KEYS;
    if (OLLAMA_API_KEY !== undefined) process.env.OLLAMA_API_KEY = OLLAMA_API_KEY;
    if (OLLAMA_PROXY_MODEL_PREFIX !== undefined)
      process.env.OLLAMA_PROXY_MODEL_PREFIX = OLLAMA_PROXY_MODEL_PREFIX;
    if (DOCUMIND_ACCORE_SERIAL !== undefined && DOCUMIND_ACCORE_SERIAL !== null) {
      process.env.DOCUMIND_ACCORE_SERIAL = String(DOCUMIND_ACCORE_SERIAL).trim();
    }
    if (DOCUMIND_ACCORE_BETWEEN_RUNS_MS !== undefined && DOCUMIND_ACCORE_BETWEEN_RUNS_MS !== null) {
      process.env.DOCUMIND_ACCORE_BETWEEN_RUNS_MS = String(DOCUMIND_ACCORE_BETWEEN_RUNS_MS).trim();
    }
    if (DOCUMIND_DELETE_AFTER_EXTRACT !== undefined && DOCUMIND_DELETE_AFTER_EXTRACT !== null) {
      process.env.DOCUMIND_DELETE_AFTER_EXTRACT = String(DOCUMIND_DELETE_AFTER_EXTRACT).trim();
    }
    if (DOCUMIND_SOURCE_FOLDER !== undefined && DOCUMIND_SOURCE_FOLDER !== null) {
      process.env.DOCUMIND_SOURCE_FOLDER = String(DOCUMIND_SOURCE_FOLDER).trim();
    }

    const llmProxySync = syncDocumindKeysToLlmProxy();
    res.json({ success: true, llmProxySync });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings', (req, res) => {
  res.json({
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    BASE_URL: process.env.BASE_URL || '',
    OLLAMA_API_KEYS: process.env.OLLAMA_API_KEYS || '',
    OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || '',
    OLLAMA_PROXY_MODEL_PREFIX: process.env.OLLAMA_PROXY_MODEL_PREFIX || '',
    ollamaKeyProxies: readOllamaKeyProxies(),
    DOCUMIND_ACCORE_SERIAL: process.env.DOCUMIND_ACCORE_SERIAL ?? '',
    DOCUMIND_ACCORE_BETWEEN_RUNS_MS: process.env.DOCUMIND_ACCORE_BETWEEN_RUNS_MS ?? '',
    DOCUMIND_DELETE_AFTER_EXTRACT: process.env.DOCUMIND_DELETE_AFTER_EXTRACT ?? '',
    DOCUMIND_SOURCE_FOLDER: process.env.DOCUMIND_SOURCE_FOLDER ?? '',
  });
});

app.post('/api/settings/ollama-proxies', (req, res) => {
  try {
    const { ollamaKeyProxies } = req.body || {};
    if (!Array.isArray(ollamaKeyProxies) || ollamaKeyProxies.length !== OLLAMA_KEY_SLOT_COUNT) {
      return res.status(400).json({
        error: `ollamaKeyProxies must be a string[${OLLAMA_KEY_SLOT_COUNT}]`,
      });
    }
    writeOllamaKeyProxies(ollamaKeyProxies);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/select-folder', (req, res) => {
  try {
    if (process.platform === 'win32') {
      const psScript = `Add-Type -AssemblyName System.Windows.Forms; $folderBrowser = New-Object System.Windows.Forms.FolderBrowserDialog; $folderBrowser.Description = 'Select the folder where your source files are located'; $folderBrowser.ShowNewFolderButton = $false; $result = $folderBrowser.ShowDialog(); if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $folderBrowser.SelectedPath }`;
      
      const result = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`, {
        encoding: 'utf8',
        timeout: 60000,
      }).trim();
      
      if (result) {
        res.json({ folderPath: result });
      } else {
        res.json({ folderPath: null });
      }
    } else {
      res.status(400).json({ error: 'Folder picker is only supported on Windows. Please enter the path manually.' });
    }
  } catch (err) {
    console.error('[select-folder] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -- Ollama usage (per key) --------------------------------------------------
// Ollama Cloud does not expose session/weekly usage via API. This endpoint attempts
// a minimal request to capture any headers; if none are returned, we show N/A in the UI.
app.get('/api/ollama-usage', async (req, res) => {
  try {
    if (isDocumindUsingLlmKeyProxy()) {
      return forwardDocumindToProxy(req, res, 'GET', '/v1/documind/ollama-usage');
    }
    const keys = [];
    const primary = process.env.OLLAMA_API_KEY?.trim();
    if (primary) keys.push(primary);
    const fromList = process.env.OLLAMA_API_KEYS;
    if (fromList && typeof fromList === 'string') {
      const parts = fromList.split(',').map((s) => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (p && !keys.includes(p)) keys.push(p);
      }
    }
    const ollamaUrl = (process.env.BASE_URL || 'http://localhost:11434').replace(/\/v1\/?$/, '');
    const isCloud = ollamaUrl.includes('ollama.com');
    const { parseOllamaSessionResetAtMs } = await import('../core/dist/ollamaSessionReset.js');
    const usage = {};
    for (let i = 0; i < Math.min(keys.length, OLLAMA_KEY_SLOT_COUNT); i++) {
      usage[i] = { session: null, weekly: null, error: null };
      if (!isCloud) {
        usage[i].error = 'Local Ollama has unlimited usage';
        continue;
      }
      try {
        const resp = await fetch(`${ollamaUrl}/api/tags`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${keys[i]}` },
          signal: AbortSignal.timeout(5000),
        });
        const headers = resp.headers;
        const sessionUsed = headers.get('x-ollama-session-used') || headers.get('x-usage-session');
        const sessionLimit = headers.get('x-ollama-session-limit') || headers.get('x-usage-session-limit');
        const weeklyUsed = headers.get('x-ollama-weekly-used') || headers.get('x-usage-weekly');
        const weeklyLimit = headers.get('x-ollama-weekly-limit') || headers.get('x-usage-weekly-limit');
        if (sessionUsed != null || sessionLimit != null) {
          usage[i].session = { used: sessionUsed ? parseFloat(sessionUsed) : null, limit: sessionLimit ? parseFloat(sessionLimit) : null };
        }
        if (weeklyUsed != null || weeklyLimit != null) {
          usage[i].weekly = { used: weeklyUsed ? parseFloat(weeklyUsed) : null, limit: weeklyLimit ? parseFloat(weeklyLimit) : null };
        }
        if (resp.status === 429) usage[i].error = 'Rate limited';
        const sessionResetAtMs = parseOllamaSessionResetAtMs(resp.headers);
        if (sessionResetAtMs != null) usage[i].sessionResetAtMs = sessionResetAtMs;
      } catch (err) {
        usage[i].error = err.message || 'Request failed';
      }
    }
    res.json({ usage, keysCount: keys.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/key-cache', async (req, res) => {
  try {
    if (isDocumindUsingLlmKeyProxy()) {
      return forwardDocumindToProxy(req, res, 'GET', '/v1/documind/key-cache');
    }
    const { getKeyCache, getQuotaUsageSnapshot } = await import('../core/dist/index.js');
    res.json({
      cache: getKeyCache(),
      quotaUsage: getQuotaUsageSnapshot(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/key-cache/clear', async (req, res) => {
  try {
    if (isDocumindUsingLlmKeyProxy()) {
      return forwardDocumindToProxy(req, res, 'POST', '/v1/documind/key-cache/clear', {});
    }
    const { clearKeyCache } = await import('../core/dist/index.js');
    clearKeyCache();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/quota-tracking', async (req, res) => {
  try {
    if (isDocumindUsingLlmKeyProxy()) {
      return forwardDocumindToProxy(req, res, 'GET', '/v1/documind/quota-tracking');
    }
    const { getQuotaUsageSnapshot } = await import('../core/dist/index.js');
    const q = getQuotaUsageSnapshot();
    const trackedKeys = [];
    const tk = q.trackedKeys || {};
    for (let i = 0; i < OLLAMA_KEY_SLOT_COUNT; i++) trackedKeys.push(tk[String(i)] !== false);
    res.json({ trackedKeys });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/quota-tracking', async (req, res) => {
  try {
    if (isDocumindUsingLlmKeyProxy()) {
      return forwardDocumindToProxy(req, res, 'POST', '/v1/documind/quota-tracking', req.body || {});
    }
    const { trackedKeys } = req.body || {};
    if (!Array.isArray(trackedKeys) || trackedKeys.length !== OLLAMA_KEY_SLOT_COUNT) {
      return res.status(400).json({
        error: `Body must include trackedKeys: boolean[${OLLAMA_KEY_SLOT_COUNT}] (Key 1 … Key ${OLLAMA_KEY_SLOT_COUNT})`,
      });
    }
    const { setOllamaQuotaTrackedKeys } = await import('../core/dist/index.js');
    setOllamaQuotaTrackedKeys(trackedKeys.map((x) => !!x));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -- Templates --------------------------------------------------------------
app.get('/api/templates', async (req, res) => {
  try {
    const { templates } = await import('../extractor/src/services/templates.js');
    const list = templates.list();
    res.json({ templates: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/templates/:name', async (req, res) => {
  try {
    const { templates } = await import('../extractor/src/services/templates.js');
    const schema = templates.get(req.params.name);
    res.json({ schema });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// -- Extract (single) -------------------------------------------------------
app.post('/api/extract', upload.single('file'), async (req, res) => {
  let uploadedPath = null;
  try {
    const { extract } = await import('../extractor/src/services/extract.js');

    let filePath = req.body.filePath;

    if (req.file) {
      const ext = path.extname(req.file.originalname);
      const newPath = req.file.path + ext;
      fs.renameSync(req.file.path, newPath);
      filePath = newPath;
      uploadedPath = newPath;
    }

    if (!filePath) {
      return res.status(400).json({ error: 'No file provided' });
    }

    let model = req.body.model || 'gpt-4o-mini';
    const openaiModels = ['gpt-4o', 'gpt-4o-mini'];
    if (openaiModels.includes(model) && !process.env.OPENAI_API_KEY) {
      model = 'llama3.2-vision';
    }
    const template = req.body.template || null;
    let schema = null;
    let autoSchema = false;

    if (req.body.schema) {
      schema = JSON.parse(req.body.schema);
    }

    if (req.body.autoSchema === 'true' || req.body.autoSchema === true) {
      autoSchema = true;
    } else if (req.body.autoSchemaInstructions) {
      autoSchema = { instructions: req.body.autoSchemaInstructions };
    }

    const uploadedFileName = req.file?.originalname || path.basename(filePath);
    const project = req.body.project?.trim() || null;
    const result = await extract({ file: filePath, schema, template, model, autoSchema, uploadedFileName, project });
    res.json(result);
  } catch (err) {
    console.error('Extract error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (uploadedPath) {
      fs.remove(uploadedPath).catch(() => { });
    }
  }
});

/** Append extraction CSV to existing Vendor Submittal workbook (sheet "Submittal"). */
app.post('/api/extract/export-submittal', upload.single('workbook'), async (req, res) => {
  let uploadedPath = null;
  try {
    const csv = req.body?.csv;
    if (csv == null || String(csv).trim() === '') {
      return res.status(400).json({ error: 'Missing csv body field with extraction CSV text' });
    }
    if (!req.file) {
      return res
        .status(400)
        .json({ error: 'Upload the Vendor Submittal spreadsheet as field "workbook"' });
    }
    const ext = path.extname(req.file.originalname || '') || '.xlsx';
    const newPath = req.file.path + ext;
    fs.renameSync(req.file.path, newPath);
    uploadedPath = newPath;
    const buf = await fs.readFile(newPath);
    const { mergeExtractCsvIntoSubmittalWorkbook } = await import('./extractCsvSubmittalMerge.js');
    const out = await mergeExtractCsvIntoSubmittalWorkbook(buf, String(csv));
    const base = path.basename(req.file.originalname || 'submittal.xlsx');
    const stem = (base.replace(/\.(xlsx|xlsm|xls)$/i, '') || 'submittal').replace(/[^\w.\-]+/g, '_').slice(0, 100) || 'submittal';
    const filename = `${stem}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(out));
  } catch (err) {
    console.error('[extract/export-submittal]', err);
    res.status(500).json({ error: err.message || 'Export failed' });
  } finally {
    if (uploadedPath) {
      fs.remove(uploadedPath).catch(() => {});
    }
  }
});

// -- Extract batch: stop early (keep stream open until partial `done` is sent) -
app.post('/api/extract-batch/stop', (req, res) => {
  const id = req.body?.sessionId;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'sessionId required' });
  }
  const ctrl = activeBatchExtractSessions.get(id);
  if (!ctrl) {
    return res.status(404).json({ error: 'Unknown or finished batch session' });
  }
  ctrl.stopRequested = true;
  res.json({ ok: true });
});

// -- Extract batch (multiple files, streaming progress) ---------------------
app.post('/api/extract-batch', uploadBatch, async (req, res) => {
  const uploadedPaths = [];
  let files = [];
  let batchSessionId = null;
  let batchSessionCtrl = null;
  try {
    const { extract } = await import('../extractor/src/services/extract.js');
    const { extractBatchToCSV } = await import('../extractor/src/utils/extractToCSV.js');

    files = getBatchUploadedFiles(req);
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    let model = req.body.model || 'gpt-4o-mini';
    const openaiModels = ['gpt-4o', 'gpt-4o-mini'];
    if (openaiModels.includes(model) && !process.env.OPENAI_API_KEY) {
      model = 'llama3.2-vision';
    }
    const template = req.body.template || null;
    let schema = null;
    let autoSchema = false;

    if (req.body.schema) {
      try {
        schema = JSON.parse(req.body.schema);
      } catch {
        schema = null;
      }
    }

    if (req.body.autoSchema === 'true' || req.body.autoSchema === true) {
      autoSchema = true;
    } else if (req.body.autoSchemaInstructions) {
      autoSchema = { instructions: req.body.autoSchemaInstructions };
    }

    const project = req.body.project?.trim() || null;

    let asyncMode = false;
    const SLOT_COUNT = OLLAMA_KEY_SLOT_COUNT;
    const maxKeyIdx = OLLAMA_KEY_SLOT_COUNT - 1;
    let asyncSlotKeys = Array.from({ length: SLOT_COUNT }, (_, i) => i);
    let asyncSlotEnabled = Array(SLOT_COUNT).fill(true);
    if (req.body.asyncMode === 'true' || req.body.asyncMode === true) {
      asyncMode = true;
      try {
        const rawKeys = req.body.asyncSlotKeys;
        const rawEnabled = req.body.asyncSlotEnabled;
        if (typeof rawKeys === 'string' && rawKeys.length > 0) {
          const parsed = JSON.parse(rawKeys);
          if (Array.isArray(parsed) && parsed.length >= 1) {
            const parsedNums = parsed.slice(0, SLOT_COUNT).map((n) => parseInt(String(n), 10));
            asyncSlotKeys = Array.from({ length: SLOT_COUNT }, (_, i) => {
              const v = parsedNums[i];
              if (v !== undefined && !isNaN(v) && v >= 0 && v <= maxKeyIdx) return v;
              return i;
            });
          }
        }
        if (typeof rawEnabled === 'string' && rawEnabled.length > 0) {
          const enabledParsed = JSON.parse(rawEnabled);
          if (Array.isArray(enabledParsed)) {
            asyncSlotEnabled = Array.from({ length: SLOT_COUNT }, (_, i) => enabledParsed[i] !== false);
          }
        }
      } catch (e) {
        console.warn('[extract-batch] Failed to parse async slot config:', e);

        asyncSlotKeys = Array.from({ length: SLOT_COUNT }, (_, i) => i);
        asyncSlotEnabled = Array(SLOT_COUNT).fill(true);
      }
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const write = (obj) => {
      res.write(JSON.stringify(obj) + '\n');
      res.flush?.();
    };
    const writeLog = (msg) => {
      console.log(msg);
      write({ type: 'log', message: msg });
    };
    /** UI stream: quota, key switches, errors (client dedupes). */
    const emitBatchActivity = (payload) => {
      write({ type: 'batchActivity', ...payload });
    };
    const truncateUi = (s, n = 220) => {
      const t = String(s ?? '');
      return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
    };
    /** PDF/image DPI metadata noise — not shown as worker errors in the batch UI. */
    const isBenignDpiOrResolutionNoise = (text) => {
      if (!text || typeof text !== 'string') return false;
      const t = text.toLowerCase();
      if (!/\bdpi\b/.test(t) && !/\bresolution\b/.test(t)) return false;
      return (
        t.includes('invalid') ||
        t.includes('wrong') ||
        (t.includes('using') && t.includes('instead')) ||
        t.includes('bad metadata') ||
        t.includes('user_defined')
      );
    };
    writeLog(`[extract-batch] START | ${files.length} file(s) | asyncMode=${req.body.asyncMode === 'true' || req.body.asyncMode === true}`);
    if (asyncMode) {
      writeLog('[extract-batch] asyncMode=ON | raw asyncSlotKeys: ' + JSON.stringify(req.body.asyncSlotKeys) + ' | raw asyncSlotEnabled: ' + JSON.stringify(req.body.asyncSlotEnabled));
      writeLog('[extract-batch] parsed asyncSlotKeys: ' + JSON.stringify(asyncSlotKeys) + ' | asyncSlotEnabled: ' + JSON.stringify(asyncSlotEnabled));
    }

    const allData = new Array(files.length);
    const total = files.length;
    const delayMs = parseInt(process.env.BATCH_DELAY_MS || '3000', 10);

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    batchSessionId = randomUUID();
    batchSessionCtrl = { stopRequested: false };
    activeBatchExtractSessions.set(batchSessionId, batchSessionCtrl);
    write({ type: 'batchSession', sessionId: batchSessionId });

    // Rename all files first
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const ext = path.extname(f.originalname);
      const newPath = f.path + ext;
      fs.renameSync(f.path, newPath);
      uploadedPaths.push(newPath);
    }

    if (asyncMode && files.length > 1) {
      const logTs = () => new Date().toISOString().slice(11, 23);
      writeLog(`[extract-batch] ASYNC MODE | ${files.length} files`);
      writeLog(`[extract-batch] Batch started at ${new Date().toISOString()}`);
      writeLog(`[extract-batch] Memory at start: ${JSON.stringify(process.memoryUsage())}`);
      
      const keysInUse = new Set();
      const overflowQueue = [];
      const enabledSlots = asyncSlotKeys
        .map((key, idx) => ({ key, idx }))
        .filter((slot, idx) => asyncSlotEnabled[idx] !== false);
      const numWorkers = Math.max(1, enabledSlots.length);
      // UI "Key 1"… (values 0..N-1) = direct indices into getOllamaApiKeys() result.
      const activeKeys = enabledSlots.length > 0
        ? enabledSlots.map((s) => Math.min(Math.max(0, s.key), maxKeyIdx))
        : [0];
      const queues = Array.from({ length: numWorkers }, () => []);
      for (let i = 0; i < files.length; i++) {
        const item = { path: uploadedPaths[i], originalname: files[i].originalname, index: i, overflowRetries: 0 };
        queues[i % numWorkers].push(item);
      }

      writeLog('[extract-batch] enabledSlots: ' + enabledSlots.map((s) => `slot${s.idx}=Key${s.key + 1}`).join(', '));
      writeLog('[extract-batch] activeKeys (0-based): ' + JSON.stringify(activeKeys) + ' | numWorkers: ' + numWorkers);
      writeLog('[extract-batch] queue distribution: ' + queues.map((q, i) => `worker${i}(Key${activeKeys[i % activeKeys.length] + 1}): ${q.length} files`).join(' | '));

      const workerCurrent = new Array(numWorkers).fill(null);
      const workerStats = Array.from({ length: numWorkers }, () => ({
        filesCompleted: 0,
        totalMs: 0,
        lastMs: 0,
      }));
      let cpuPrev = process.cpuUsage();

      const emitBatchState = () => {
        const mem = process.memoryUsage();
        const cpu = process.cpuUsage();
        const cpuDelta = {
          user: Math.max(0, cpu.user - cpuPrev.user),
          system: Math.max(0, cpu.system - cpuPrev.system),
        };
        cpuPrev = cpu;
        const workers = [];
        for (let i = 0; i < numWorkers; i++) {
          const ws = workerStats[i];
          const avgMs = ws.filesCompleted > 0 ? Math.round(ws.totalMs / ws.filesCompleted) : 0;
          workers.push({
            workerIndex: i,
            assignedKeyLabel: `Key${activeKeys[i % activeKeys.length] + 1}`,
            currentFile: workerCurrent[i]?.originalname || null,
            queue: queues[i].map((q) => q.originalname),
            status: workerCurrent[i] ? 'working' : 'idle',
            stats: {
              filesCompleted: ws.filesCompleted,
              totalMs: ws.totalMs,
              lastMs: ws.lastMs,
              avgMs,
            },
          });
        }
        write({
          type: 'batchState',
          mode: 'async',
          workers,
          overflowQueue: overflowQueue.map((q) => q.originalname),
          total,
          completed: allData.filter((x) => x !== undefined).length,
          memory: {
            heapUsed: mem.heapUsed,
            heapTotal: mem.heapTotal,
            rss: mem.rss,
            external: mem.external,
          },
          cpuDeltaMicros: cpuDelta,
          loadAvg: typeof os.loadavg === 'function' ? os.loadavg() : null,
        });
      };

      emitBatchState();

      const findFreeKey = () => {
        for (const k of activeKeys) {
          if (!keysInUse.has(k)) return k;
        }
        return null;
      };

      const is429 = (err) => err?.message?.includes('429') || err?.response?.status === 429;
      const is500 = (err) => err?.message?.includes('500') || err?.response?.status === 500 || err?.message?.includes('Internal Server Error');

      const runWorker = async (slotIndex) => {
        const myKeyIdx = activeKeys[slotIndex % activeKeys.length];
        const myQueue = queues[slotIndex];
        console.log(`[${logTs()}] worker${slotIndex} START | assigned Key${myKeyIdx + 1} (idx ${myKeyIdx}) | queue size: ${myQueue.length}`);
        while (true) {
          if (batchSessionCtrl.stopRequested) {
            console.log(`[${logTs()}] worker${slotIndex} EXIT (stop requested)`);
            break;
          }
          let item = myQueue.shift() || overflowQueue.shift();
          if (!item) {
            console.log(`[${logTs()}] worker${slotIndex} EXIT (no more items)`);
            break;
          }
          
          console.log(`[${logTs()}] worker${slotIndex} PROCESSING "${item.originalname}" (converting PDF/DWG)`);
          workerCurrent[slotIndex] = item;
          emitBatchState();
          
          let conversionResult = null;
          let keyToUse = myKeyIdx;
          const isDWG = /\.dwg$/i.test(item.path);

          try {
            // Phase 1: Convert file to markdown (PDF/DWG processing) 
            // For DWGs, we wait for a Key FIRST to avoid "background processing" collisions.
            if (isDWG) {
              while (keysInUse.has(keyToUse)) {
                console.log(`[${logTs()}] worker${slotIndex} WAITING for Key${keyToUse + 1} (before DWG conversion)`);
                await new Promise(resolve => setTimeout(resolve, 100));
                if (batchSessionCtrl.stopRequested) break;
              }
              if (batchSessionCtrl.stopRequested) break;
              keysInUse.add(keyToUse);
            }

            const { convertFile } = await import('../extractor/src/converter.js');
            conversionResult = await convertFile(item.path, model, {
              metadataOnly: !isDWG,
            });
            console.log(`[${logTs()}] worker${slotIndex} CONVERTED "${item.originalname}" (${conversionResult.totalPages} pages)`);
          } catch (err) {
            if (isDWG) keysInUse.delete(keyToUse);
            console.error(`[${logTs()}] worker${slotIndex} CONVERSION FAILED "${item.originalname}":`, err);
            allData[item.index] = { filename: item.originalname, _error: `Conversion failed: ${err.message}` };
            workerCurrent[slotIndex] = null;
            emitBatchState();
            const completed = allData.filter((x) => x !== undefined).length;
            write({ type: 'progress', current: completed, total, percent: Math.round((completed / total) * 100), fileName: item.originalname });
            continue;
          }
          
          if (!isDWG) {
            // Phase 2: WAIT for the assigned key to become available (for non-DWGs)
            while (keysInUse.has(keyToUse)) {
              console.log(`[${logTs()}] worker${slotIndex} WAITING for Key${keyToUse + 1} (converted "${item.originalname}" ready for extraction)`);
              await new Promise(resolve => setTimeout(resolve, 100));
              if (batchSessionCtrl.stopRequested) break;
            }
            if (batchSessionCtrl.stopRequested) break;
            keysInUse.add(keyToUse);
          }
          
          console.log(`[${logTs()}] worker${slotIndex} EXTRACTING "${item.originalname}" | using Key${keyToUse + 1} (idx ${keyToUse})`);
          writeLog(
            `[extract-batch] worker ${slotIndex + 1} · ${item.originalname} · Key ${keyToUse + 1} · extraction started`
          );
          emitBatchState();
          let done = false;
          while (!done) {
            try {
              const t0 = Date.now();
              // Phase 3: Extract data from markdown using LLM (NEEDS KEY)
              const result = await extract({
                file: item.path,
                schema,
                template,
                model,
                autoSchema,
                uploadedFileName: item.originalname,
                project,
                preferredKeyIndex: keyToUse,
                keysInUse,
                preconvertedMarkdown: conversionResult,
              });
              const ms = Date.now() - t0;
              workerStats[slotIndex].filesCompleted += 1;
              workerStats[slotIndex].totalMs += ms;
              workerStats[slotIndex].lastMs = ms;
              allData[item.index] = result?.data || { filename: item.originalname };
              console.log(`[${logTs()}] worker${slotIndex} DONE "${item.originalname}" (Key${keyToUse + 1})`);
              writeLog(
                `[extract-batch] worker ${slotIndex + 1} · ${item.originalname} · Key ${keyToUse + 1} · done (${ms}ms)`
              );
              keysInUse.delete(keyToUse);
              done = true;
            } catch (err) {
              const completed = allData.filter((x) => x !== undefined).length;
              const percentComplete = Math.round((completed / total) * 100);
              const mem = process.memoryUsage();
              
              const errorDetails = {
                file: item.originalname,
                percentComplete,
                completed,
                total,
                workerIndex: slotIndex,
                keyIndex: keyToUse,
                error: err?.message || String(err),
                status: err?.response?.status || err?.status,
                code: err?.code,
                stack: err?.stack,
                memory: {
                  heapUsedMB: Math.round(mem.heapUsed/1024/1024),
                  rssMB: Math.round(mem.rss/1024/1024),
                  heapTotalMB: Math.round(mem.heapTotal/1024/1024),
                },
              };
              
              if (batchLogger) {
                batchLogger.logError(`Batch extraction error at ${percentComplete}%`, errorDetails);
              }
              
              writeLog(`[extract-batch] ERROR at ${percentComplete}% (${completed}/${total}) | File: ${item.originalname} | Worker: ${slotIndex} | Key: ${keyToUse + 1}`);
              writeLog(`[extract-batch] Error: ${err?.message || String(err)} | Status: ${err?.response?.status || err?.status || 'unknown'} | Code: ${err?.code || 'none'}`);
              writeLog(`[extract-batch] Memory: heap=${Math.round(mem.heapUsed/1024/1024)}MB rss=${Math.round(mem.rss/1024/1024)}MB`);
              
              if (is429(err)) {
                keysInUse.delete(keyToUse);
                const failedKey = keyToUse;
                emitBatchActivity({
                  kind: 'quota',
                  workerIndex: slotIndex,
                  file: item.originalname,
                  key: failedKey + 1,
                  message: `Quota hit (429) on Key ${failedKey + 1}`,
                });
                console.log(`[${logTs()}] worker${slotIndex} 429 on Key${failedKey + 1} for "${item.originalname}"`);
                const freeKey = findFreeKey();
                if (freeKey !== null) {
                  keyToUse = freeKey;
                  emitBatchActivity({
                    kind: 'keySwitch',
                    workerIndex: slotIndex,
                    file: item.originalname,
                    fromKey: failedKey + 1,
                    toKey: keyToUse + 1,
                  });
                  console.log(`[${logTs()}] worker${slotIndex} SWITCH to Key${keyToUse + 1} (idx ${keyToUse}) | retrying "${item.originalname}"`);
                } else {
                  item.overflowRetries = (item.overflowRetries || 0) + 1;
                  if (item.overflowRetries >= 3) {
                    emitBatchActivity({
                      kind: 'error',
                      workerIndex: slotIndex,
                      file: item.originalname,
                      message: 'Rate limited (429) — retries exhausted',
                    });
                    console.log(`[${logTs()}] worker${slotIndex} 429 FAIL "${item.originalname}" (retries exhausted)`);
                    allData[item.index] = { filename: item.originalname, _error: 'Rate limited (429) after retries' };
                    done = true;
                  } else {
                    emitBatchActivity({
                      kind: 'overflow',
                      workerIndex: slotIndex,
                      file: item.originalname,
                      message: `All keys busy — queued for retry (${item.overflowRetries}/3)`,
                    });
                    console.log(`[${logTs()}] worker${slotIndex} 429 DEFER "${item.originalname}" to overflow (retry ${item.overflowRetries}/3, all keys busy)`);
                    overflowQueue.push(item);
                    done = true;
                  }
                }
              } else if (is500(err)) {
                keysInUse.delete(keyToUse);
                item.serverErrorRetries = (item.serverErrorRetries || 0) + 1;
                
                if (batchLogger) {
                  batchLogger.logWarn('500 error - retrying', {
                    file: item.originalname,
                    attempt: item.serverErrorRetries,
                    maxRetries: 3,
                    workerIndex: slotIndex,
                    keyIndex: keyToUse,
                  });
                }
                
                if (item.serverErrorRetries >= 3) {
                  if (batchLogger) {
                    batchLogger.logError('500 error - retries exhausted', {
                      file: item.originalname,
                      attempts: item.serverErrorRetries,
                      workerIndex: slotIndex,
                      keyIndex: keyToUse,
                    });
                  }
                  
                  emitBatchActivity({
                    kind: 'error',
                    workerIndex: slotIndex,
                    file: item.originalname,
                    message: 'Server error (500) — retries exhausted',
                  });
                  console.log(`[${logTs()}] worker${slotIndex} 500 FAIL "${item.originalname}" (retries exhausted after ${item.serverErrorRetries} attempts)`);
                  allData[item.index] = { filename: item.originalname, _error: 'Server error (500) after retries' };
                  done = true;
                } else {
                  emitBatchActivity({
                    kind: 'overflow',
                    workerIndex: slotIndex,
                    file: item.originalname,
                    message: `Server error (500) — queued for retry (${item.serverErrorRetries}/3)`,
                  });
                  console.log(`[${logTs()}] worker${slotIndex} 500 RETRY "${item.originalname}" (attempt ${item.serverErrorRetries}/3, waiting 5s)`);
                  await new Promise(resolve => setTimeout(resolve, 5000));
                  overflowQueue.push(item);
                  done = true;
                }
              } else {
                keysInUse.delete(keyToUse);
                if (batchLogger) {
                  batchLogger.logError('Non-retryable extraction error', {
                    file: item.originalname,
                    error: err?.message || String(err),
                    workerIndex: slotIndex,
                    keyIndex: keyToUse,
                  });
                }
                
                console.error(`Extract error for ${item.originalname}:`, err);
                const raw = err?.message || String(err);
                if (!isBenignDpiOrResolutionNoise(raw)) {
                  emitBatchActivity({
                    kind: 'error',
                    workerIndex: slotIndex,
                    file: item.originalname,
                    message: truncateUi(raw),
                  });
                }
                allData[item.index] = { filename: item.originalname, _error: raw };
                done = true;
              }
            }
          }
          workerCurrent[slotIndex] = null;
          emitBatchState();
          keysInUse.delete(keyToUse);
          const completed = allData.filter((x) => x !== undefined).length;
          write({ type: 'progress', current: completed, total, percent: Math.round((completed / total) * 100), fileName: item.originalname });
        }
      };

      await Promise.all(queues.map((_, i) => runWorker(i)));

      const asyncPendingMsg = batchSessionCtrl.stopRequested
        ? 'Not processed (batch stopped early)'
        : 'Failed to process';
      for (let i = 0; i < allData.length; i++) {
        if (allData[i] === undefined) {
          allData[i] = { filename: files[i].originalname, _error: asyncPendingMsg };
        }
      }
      if (batchSessionCtrl.stopRequested) {
        writeLog('[extract-batch] Batch stopped by user — returning partial results');
      }
    } else {
      writeLog(`[extract-batch] SEQUENTIAL MODE | ${files.length} file(s)`);
      const seqStats = { filesCompleted: 0, totalMs: 0, lastMs: 0 };
      let cpuPrevSeq = process.cpuUsage();
      const emitSeqState = (currentFile, queueNames, completedCount) => {
        const mem = process.memoryUsage();
        const cpu = process.cpuUsage();
        const cpuDelta = {
          user: Math.max(0, cpu.user - cpuPrevSeq.user),
          system: Math.max(0, cpu.system - cpuPrevSeq.system),
        };
        cpuPrevSeq = cpu;
        const avgMs = seqStats.filesCompleted > 0 ? Math.round(seqStats.totalMs / seqStats.filesCompleted) : 0;
        write({
          type: 'batchState',
          mode: 'sequential',
          workers: [
            {
              workerIndex: 0,
              assignedKeyLabel: 'Default',
              currentFile: currentFile,
              queue: queueNames,
              status: currentFile ? 'working' : 'idle',
              stats: {
                filesCompleted: seqStats.filesCompleted,
                totalMs: seqStats.totalMs,
                lastMs: seqStats.lastMs,
                avgMs,
              },
            },
          ],
          overflowQueue: [],
          total,
          completed: completedCount,
          memory: {
            heapUsed: mem.heapUsed,
            heapTotal: mem.heapTotal,
            rss: mem.rss,
            external: mem.external,
          },
          cpuDeltaMicros: cpuDelta,
          loadAvg: typeof os.loadavg === 'function' ? os.loadavg() : null,
        });
      };
      emitSeqState(null, files.map((ff) => ff.originalname), 0);

      for (let i = 0; i < files.length; i++) {
        if (batchSessionCtrl.stopRequested) {
          writeLog('[extract-batch] Batch stopped by user — returning partial results');
          break;
        }
        if (i > 0) await sleep(delayMs);

        const f = files[i];
        const newPath = uploadedPaths[i];
        const remaining = files.slice(i + 1).map((ff) => ff.originalname);
        writeLog(`[extract-batch] Processing ${i + 1}/${files.length}: ${f.originalname}`);

        emitSeqState(f.originalname, remaining, allData.filter((x) => x !== undefined).length);

        write({
          type: 'progress',
          current: i + 1,
          total,
          fileName: f.originalname,
          percent: Math.round(((i + 1) / total) * 100),
        });

        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const t0 = Date.now();
            const result = await extract({
              file: newPath,
              schema,
              template,
              model,
              autoSchema,
              uploadedFileName: f.originalname,
              project,
            });
            const ms = Date.now() - t0;
            seqStats.filesCompleted += 1;
            seqStats.totalMs += ms;
            seqStats.lastMs = ms;
            if (result?.data) allData[i] = result.data;
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            const is429 = err.message?.includes('429') || err.response?.status === 429;
            if (is429 && attempt < 2) {
              emitBatchActivity({
                kind: 'quota',
                workerIndex: 0,
                file: f.originalname,
                message: `Quota (429) — waiting ${(attempt + 1) * 10}s before retry ${attempt + 2}/3`,
              });
              const backoff = (attempt + 1) * 10000;
              await sleep(backoff);
            } else {
              break;
            }
          }
        }
        if (lastErr) {
          console.error(`Extract error for ${f.originalname}:`, lastErr);
          const raw = lastErr.message || String(lastErr);
          if (!isBenignDpiOrResolutionNoise(raw)) {
            emitBatchActivity({
              kind: 'error',
              workerIndex: 0,
              file: f.originalname,
              message: truncateUi(raw),
            });
          }
          allData[i] = { filename: f.originalname, _error: raw };
        }
        emitSeqState(null, remaining, allData.filter((x) => x !== undefined).length);
      }

      if (batchSessionCtrl.stopRequested) {
        const seqPendingMsg = 'Not processed (batch stopped early)';
        for (let i = 0; i < allData.length; i++) {
          if (allData[i] === undefined) {
            allData[i] = { filename: files[i].originalname, _error: seqPendingMsg };
          }
        }
      }
    }

    const csv = extractBatchToCSV(allData.filter((d) => d && !d._error));
    const successful = allData.filter((d) => d && !d._error);
    writeLog(`[extract-batch] DONE | ${successful.length}/${allData.length} succeeded`);
    
    // Delete source files if enabled and source folder is configured
    if (successful.length > 0 && process.env.DOCUMIND_DELETE_AFTER_EXTRACT === '1' && process.env.DOCUMIND_SOURCE_FOLDER) {
      try {
        const sourceFolder = process.env.DOCUMIND_SOURCE_FOLDER.trim();
        const pathsToDelete = [];
        for (let i = 0; i < allData.length; i++) {
          if (allData[i] && !allData[i]._error && files[i]) {
            const fullPath = path.join(sourceFolder, files[i].originalname);
            pathsToDelete.push(fullPath);
          }
        }
        if (pathsToDelete.length > 0) {
          const deleteResult = await deleteSourceFilesIfEnabled(pathsToDelete);
          if (deleteResult.deleted > 0) {
            writeLog(`[extract-batch] Deleted ${deleteResult.deleted} source file(s) from ${sourceFolder}`);
          }
          if (deleteResult.errors.length > 0) {
            writeLog(`[extract-batch] Failed to delete ${deleteResult.errors.length} file(s)`);
          }
        }
      } catch (err) {
        console.error('[extract-batch] Error deleting source files:', err);
      }
    }
    
    const rateLimited = allData.filter((d) => d && d._error && (String(d._error).includes('429') || String(d._error).includes('Rate limited')));
    let lastCompletedIndex = -1;
    let lastCompletedFileName = null;
    for (let i = allData.length - 1; i >= 0; i--) {
      if (allData[i] && !allData[i]._error) {
        lastCompletedIndex = i;
        lastCompletedFileName = allData[i].filename || files[i]?.originalname || `file ${i + 1}`;
        break;
      }
    }
    const resumeFromIndex = lastCompletedIndex >= 0 ? lastCompletedIndex + 1 : 0;
    const stoppedEarly =
      batchSessionCtrl?.stopRequested === true &&
      allData.some(
        (d) =>
          d &&
          d._error &&
          String(d._error).includes('Not processed (batch stopped early)')
      );
    write({
      type: 'done',
      success: true,
      data: allData,
      csv,
      total: allData.length,
      rateLimitedCount: rateLimited.length,
      lastCompletedFileName: lastCompletedFileName || null,
      lastCompletedIndex: lastCompletedIndex >= 0 ? lastCompletedIndex : null,
      resumeFromIndex: rateLimited.length > 0 ? resumeFromIndex : null,
      stoppedEarly,
    });
  } catch (err) {
    console.error('Extract batch error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(JSON.stringify({ type: 'error', error: err.message }) + '\n');
    }
  } finally {
    if (batchSessionId) activeBatchExtractSessions.delete(batchSessionId);
    for (const p of uploadedPaths) {
      fs.remove(p).catch(() => { });
    }
    res.end();
  }
});

// -- Format (markdown / plaintext) ------------------------------------------
app.post('/api/format', upload.single('file'), async (req, res) => {
  let uploadedPath = null;
  try {
    const { formatter } = await import('../extractor/src/services/formatter.js');

    let filePath = req.body.filePath;

    if (req.file) {
      const ext = path.extname(req.file.originalname);
      const newPath = req.file.path + ext;
      fs.renameSync(req.file.path, newPath);
      filePath = newPath;
      uploadedPath = newPath;
    }

    if (!filePath) {
      return res.status(400).json({ error: 'No file provided' });
    }

    let model = req.body.model || 'gpt-4o-mini';
    if (['gpt-4o', 'gpt-4o-mini'].includes(model) && !process.env.OPENAI_API_KEY) {
      model = 'llama3.2-vision';
    }
    const format = req.body.format || 'markdown';

    let result;
    if (format === 'plaintext') {
      result = await formatter.plaintext({ file: filePath, model });
    } else {
      result = await formatter.markdown({ file: filePath, model });
    }

    res.json({ success: true, content: result, format });
  } catch (err) {
    console.error('Format error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (uploadedPath) {
      fs.remove(uploadedPath).catch(() => { });
    }
  }
});

// -- Ollama installed models (for local Ollama) -----------------------------
app.get('/api/ollama-models', async (req, res) => {
  try {
    const baseUrl = process.env.BASE_URL || 'http://localhost:11434/v1';
    const rootUrl = baseUrl.replace(/\/v1\/?$/, '') || 'http://localhost:11434';
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(rootUrl);
    if (!isLocal) {
      return res.json({ models: [], error: 'Ollama model list only available for local Ollama' });
    }
    const isLlmKeyProxy = /127\.0\.0\.1:8000|localhost:8000/i.test(rootUrl);
    if (isLlmKeyProxy) {
      const proxyKey = process.env.OLLAMA_API_KEY?.trim();
      const headers = {};
      if (proxyKey) headers.Authorization = `Bearer ${proxyKey}`;
      const r = await fetch(`${rootUrl}/v1/models`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) {
        return res.json({
          models: [],
          error: r.status === 401 ? 'Invalid proxy API key (OLLAMA_API_KEY vs PROXY_API_KEY)' : `Proxy error: ${r.status}`,
        });
      }
      const data = await r.json();
      const models = (data.data || []).map(m => m.id).filter(Boolean);
      return res.json({ models });
    }
    const r = await fetch(`${rootUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) {
      return res.json({ models: [], error: r.status === 404 ? 'Ollama not running' : `Ollama error: ${r.status}` });
    }
    const data = await r.json();
    const models = (data.models || []).map(m => m.name || m.model).filter(Boolean);
    res.json({ models });
  } catch (err) {
    res.json({ models: [], error: err.cause?.code === 'ECONNREFUSED' ? 'Ollama not running' : err.message });
  }
});

// -- Models list ------------------------------------------------------------
app.get('/api/models', (req, res) => {
  res.json({
    models: [
      { id: 'gpt-4o', provider: 'OpenAI', requiresKey: 'OPENAI_API_KEY' },
      { id: 'gpt-4o-mini', provider: 'OpenAI', requiresKey: 'OPENAI_API_KEY' },
      { id: 'gemini-2.0-flash-001', provider: 'Google', requiresKey: 'GEMINI_API_KEY' },
      { id: 'gemini-2.0-flash-lite-preview-02-05', provider: 'Google', requiresKey: 'GEMINI_API_KEY' },
      { id: 'gemini-1.5-flash', provider: 'Google', requiresKey: 'GEMINI_API_KEY' },
      { id: 'gemini-1.5-flash-8b', provider: 'Google', requiresKey: 'GEMINI_API_KEY' },
      { id: 'gemini-1.5-pro', provider: 'Google', requiresKey: 'GEMINI_API_KEY' },
      { id: 'llama3.2-vision', provider: 'Ollama (local)', requiresKey: 'BASE_URL' },
      { id: 'gemma4:31b-cloud', provider: 'Ollama Cloud', requiresKey: 'BASE_URL' },
      { id: 'qwen2.5vl', provider: 'Ollama (local)', requiresKey: 'BASE_URL' },
      { id: 'qwen2.5vl:3b', provider: 'Ollama (local)', requiresKey: 'BASE_URL' },
      { id: 'qwen2.5vl:7b', provider: 'Ollama (local)', requiresKey: 'BASE_URL' },
      { id: 'qwen2.5vl:32b', provider: 'Ollama (local)', requiresKey: 'BASE_URL' },
      { id: 'qwen2.5vl:72b', provider: 'Ollama (local)', requiresKey: 'BASE_URL' },
      { id: 'qwen3.5', provider: 'Ollama (local)', requiresKey: 'BASE_URL' },
      { id: 'qwen3.5:0.8b', provider: 'Ollama (local)', requiresKey: 'BASE_URL' },
      { id: 'qwen3.5:2b', provider: 'Ollama (local)', requiresKey: 'BASE_URL' },
      { id: 'qwen3.5:4b', provider: 'Ollama (local)', requiresKey: 'BASE_URL' },
      { id: 'qwen3.5:9b', provider: 'Ollama (local)', requiresKey: 'BASE_URL' },
      { id: 'qwen3.5:9b-q4_K_M', provider: 'Ollama (local)', requiresKey: 'BASE_URL' },
      { id: 'qwen3.5:27b', provider: 'Ollama (local)', requiresKey: 'BASE_URL' },
      { id: 'qwen3.5:35b', provider: 'Ollama (local)', requiresKey: 'BASE_URL' },
      { id: 'qwen3.5:122b', provider: 'Ollama (local)', requiresKey: 'BASE_URL' },
      { id: 'qwen3.5:122b-a10b', provider: 'Ollama (local)', requiresKey: 'BASE_URL' },
      { id: 'qwen3.5:35b-a3b', provider: 'Ollama (local)', requiresKey: 'BASE_URL' },
      { id: 'qwen3-vl', provider: 'Ollama (local)', requiresKey: 'BASE_URL' },
      { id: 'qwen3-vl:8b', provider: 'Ollama (local)', requiresKey: 'BASE_URL' },
    ],
  });
});

// -- Submittal (transmittal / drawing list → vendor sheet, no LLM) ----------
function submittalUploadRename(files) {
  const uploadedPaths = [];
  const renameWithExt = (file) => {
    const ext = path.extname(file.originalname || '') || '.xlsx';
    const newPath = file.path + ext;
    fs.renameSync(file.path, newPath);
    return newPath;
  };
  const templateFile = files.find((f) => f.fieldname === 'template');
  const sourceFiles = files.filter((f) => f.fieldname === 'sources' || f.fieldname === 'source');
  if (sourceFiles.length === 0) {
    return { error: 'Add at least one source spreadsheet (field: sources)' };
  }
  const sourcePaths = [];
  for (const f of sourceFiles) {
    const p = renameWithExt(f);
    uploadedPaths.push(p);
    sourcePaths.push(p);
  }
  let templatePath = null;
  if (templateFile) {
    templatePath = renameWithExt(templateFile);
    uploadedPaths.push(templatePath);
  }
  return { uploadedPaths, sourcePaths, templatePath };
}

app.post('/api/submittal/preview', uploadBatch, async (req, res) => {
  const uploadedPaths = [];
  try {
    const files = getBatchUploadedFiles(req);
    const prep = submittalUploadRename(files);
    if (prep.error) {
      return res.status(400).json({ error: prep.error });
    }
    uploadedPaths.push(...prep.uploadedPaths);
    const { buildSubmittalMergePayload } = await import('./submittalImport.js');
    const payload = buildSubmittalMergePayload(prep.sourcePaths, prep.templatePath);
    res.json(payload);
  } catch (err) {
    console.error('[submittal/preview]', err);
    res.status(500).json({ error: err.message || 'Preview failed' });
  } finally {
    for (const p of uploadedPaths) {
      fs.remove(p).catch(() => {});
    }
  }
});

app.post('/api/submittal/export', async (req, res) => {
  try {
    const body = req.body || {};
    const { sheetName, preRows, headers, rows } = body;
    if (!Array.isArray(headers) || !Array.isArray(rows)) {
      return res.status(400).json({ error: 'JSON body must include headers: string[] and rows: string[][]' });
    }
    if (headers.length > 512 || rows.length > 500000) {
      return res.status(400).json({ error: 'Grid too large (max 512 columns × 500k rows)' });
    }
    const toStr = (x) => (x == null ? '' : String(x));
    const safeHeaders = headers.map(toStr);
    const safeRows = rows.map((r) => (Array.isArray(r) ? r : []).map(toStr));
    const safePre = Array.isArray(preRows)
      ? preRows.map((r) => (Array.isArray(r) ? r : []).map(toStr))
      : [];
    const { workbookBufferFromSubmittalGrid } = await import('./submittalImport.js');
    const buffer = workbookBufferFromSubmittalGrid({
      sheetName: toStr(sheetName || '1. Submittal'),
      preRows: safePre,
      headers: safeHeaders,
      rows: safeRows,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="submittal-merged.xlsx"');
    res.send(buffer);
  } catch (err) {
    console.error('[submittal/export]', err);
    res.status(500).json({ error: err.message || 'Export failed' });
  }
});

app.post('/api/submittal/merge', uploadBatch, async (req, res) => {
  const uploadedPaths = [];
  try {
    const files = getBatchUploadedFiles(req);
    const prep = submittalUploadRename(files);
    if (prep.error) {
      return res.status(400).json({ error: prep.error });
    }
    uploadedPaths.push(...prep.uploadedPaths);
    const { mergeTransmittalsToSubmittal } = await import('./submittalImport.js');
    const { buffer, summary } = mergeTransmittalsToSubmittal(prep.sourcePaths, prep.templatePath);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="submittal-merged.xlsx"');
    res.setHeader('X-Submittal-Summary', encodeURIComponent(JSON.stringify(summary)));
    res.send(buffer);
  } catch (err) {
    console.error('[submittal/merge]', err);
    res.status(500).json({ error: err.message || 'Merge failed' });
  } finally {
    for (const p of uploadedPaths) {
      fs.remove(p).catch(() => {});
    }
  }
});

// -- Start ------------------------------------------------------------------
const PORT = process.env.PORT || 3456;
app.get('/api/log-file', (req, res) => {
  const logDir = path.join(__dirname, '../logs');
  if (!fs.existsSync(logDir)) {
    return res.json({ logFile: null, message: 'No logs directory found' });
  }
  
  const files = fs.readdirSync(logDir)
    .filter(f => f.startsWith('batch-') && f.endsWith('.log'))
    .map(f => ({
      name: f,
      path: path.join(logDir, f),
      mtime: fs.statSync(path.join(logDir, f)).mtime,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  
  if (files.length === 0) {
    return res.json({ logFile: null, message: 'No log files found' });
  }
  
  res.json({ 
    logFile: files[0].path,
    allLogs: files.map(f => ({ name: f.name, path: f.path })),
  });
});

app.listen(PORT, () => {
  syncDocumindKeysToLlmProxy();
  console.log(`\n  Documind GUI running at http://localhost:${PORT}\n`);
});
