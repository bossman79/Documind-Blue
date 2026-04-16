import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_DIR = path.join(__dirname, '../../../logs');
const LOG_FILE = path.join(LOG_DIR, `batch-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

// Create logs directory
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Open log file with append flag
let logStream = null;
try {
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
} catch (err) {
  console.error('Failed to create log file:', err);
}

function timestamp() {
  return new Date().toISOString();
}

function writeLog(level, message, data = null) {
  const entry = {
    timestamp: timestamp(),
    level,
    message,
    ...(data && { data }),
  };
  
  const line = JSON.stringify(entry) + '\n';
  
  // Write to console
  console.log(`[${level}] ${message}`, data || '');
  
  // Write to file immediately (unbuffered)
  if (logStream) {
    try {
      logStream.write(line);
      // Force flush to disk
      if (logStream.fd) {
        fs.fsyncSync(logStream.fd);
      }
    } catch (err) {
      console.error('Failed to write log:', err);
    }
  }
}

export function logInfo(message, data) {
  writeLog('INFO', message, data);
}

export function logWarn(message, data) {
  writeLog('WARN', message, data);
}

export function logError(message, data) {
  writeLog('ERROR', message, data);
}

export function logDebug(message, data) {
  writeLog('DEBUG', message, data);
}

export function getLogFilePath() {
  return LOG_FILE;
}

// Log startup
logInfo('Crash logger initialized', { logFile: LOG_FILE });

// Handle process crashes
process.on('uncaughtException', (err) => {
  logError('UNCAUGHT EXCEPTION - PROCESS CRASH', {
    error: err.message,
    stack: err.stack,
  });
  if (logStream) {
    logStream.end();
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logError('UNHANDLED REJECTION', {
    reason: String(reason),
    promise: String(promise),
  });
});
