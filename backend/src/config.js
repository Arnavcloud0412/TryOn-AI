import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
let provider = (process.env.AI_PROVIDER || 'gemini').trim().toLowerCase();
if (provider === 'gemini' && !geminiKey) {
  console.warn('[config] GEMINI_API_KEY is not set - falling back to the "mock" AI provider.');
  provider = 'mock';
}

export const config = {
  port: Number(process.env.PORT) || 8787,
  onVercel: Boolean(process.env.VERCEL),
  databaseUrl: process.env.DATABASE_URL || process.env.POSTGRES_URL || '',
  useBlob: Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID),
  dataDir: path.resolve(backendRoot, process.env.DATA_DIR || './data'),
  provider,
  gemini: {
    apiKey: geminiKey,
    model: process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
    fastModel: process.env.GEMINI_FAST_MODEL || process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
    baseUrl: 'https://generativelanguage.googleapis.com',
    timeoutMs: 150_000,
  },
  // Generation runs inside the request's function invocation via waitUntil, so it
  // must finish within the function max duration (300 s on every Vercel plan).
  jobBudgetMs: 270_000,
  staleJobMs: 330_000,
  maxRunningJobsPerUser: Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS) || 2),
  tryOnLimitPerHour: Math.max(1, Number(process.env.TRYON_LIMIT_PER_HOUR) || 40),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  images: {
    profileMaxEdge: 1280,
    productMaxEdge: 1024,
    // Vercel Functions cap request bodies at 4.5 MB; the extension downsizes before upload.
    maxUploadBytes: 4 * 1024 * 1024,
    maxRemoteBytes: 15 * 1024 * 1024,
    productCacheTtlMs: 7 * 24 * 3600 * 1000,
  },
  promptVersion: 3,
};
