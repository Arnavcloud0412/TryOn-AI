import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { config } from './config.js';
import { requireAuth } from './auth.js';
import { getCatalog } from './catalog.js';
import { providerName, modelName } from './ai/index.js';
import { dbDriver } from './db/index.js';
import { blobDriver } from './blobs.js';
import accountRoutes from './routes/account.js';
import profileRoutes from './routes/profiles.js';
import productRoutes from './routes/products.js';
import tryonRoutes from './routes/tryon.js';
import { HttpError } from './util.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (config.allowedOrigins.length) return cb(null, config.allowedOrigins.includes(origin));
    return cb(null, origin.startsWith('chrome-extension://'));
  },
}));
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-site',
  });
  next();
});
app.use(express.json({ limit: '200kb' }));

app.get('/', (_req, res) => res.json({ name: 'TryOn AI API', health: '/api/health' }));

app.get('/api/health', (_req, res) => {
  const storageOk = !config.onVercel || (dbDriver === 'postgres' && blobDriver === 'vercel-blob-private');
  res.status(storageOk ? 200 : 503).json({
    ok: storageOk,
    provider: providerName,
    model: modelName,
    database: dbDriver,
    storage: blobDriver,
    ...(storageOk ? {} : { error: 'Storage not configured: connect Neon Postgres (DATABASE_URL) and a private Blob store to this Vercel project.' }),
  });
});

app.get('/api/config', (_req, res) => {
  const c = getCatalog();
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    provider: providerName,
    model: modelName,
    photoSlots: c.photoSlots,
    categories: Object.fromEntries(Object.entries(c.categories).map(([k, v]) => [k, {
      label: v.label, photos: v.photos, keywords: v.keywords,
    }])),
    scenes: Object.fromEntries(Object.entries(c.scenes).map(([k, v]) => [k, { label: v.label }])),
    privacy: {
      storage: blobDriver === 'vercel-blob-private'
        ? 'Profile photos and results are stored in a private Vercel Blob store and are only accessible with your device token.'
        : 'Profile photos and results are stored privately on this server and are only accessible with your device token.',
      training: 'Your photos are never used to train AI models.',
    },
  });
});

app.use('/api', accountRoutes);
app.use('/api', requireAuth, profileRoutes, productRoutes, tryonRoutes);

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Endpoint not found.')));

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({ error: { code: tooBig ? 'FILE_TOO_LARGE' : 'UPLOAD_ERROR', message: tooBig ? 'Image is too large (max 4 MB).' : err.message } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON body.' } });
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: {
      code: err.code || 'INTERNAL',
      message: status >= 500 && !(err instanceof HttpError) ? 'Internal server error.' : err.message,
    },
  });
});

// On Vercel the exported app is invoked as a Function; locally we run an HTTP server.
if (!config.onVercel) {
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`TryOn AI backend listening on http://127.0.0.1:${config.port}`);
    console.log(`AI: ${providerName} (${modelName}) | database: ${dbDriver} | storage: ${blobDriver}`);
  });
}

export default app;
