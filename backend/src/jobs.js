import sharp from 'sharp';
import { config } from './config.js';
import { db } from './db/index.js';
import { blobs, keys } from './blobs.js';
import { provider, providerName, modelName } from './ai/index.js';
import { buildPrompt, resolveScene, selectProfilePhotos } from './prompt.js';
import { getCatalog } from './catalog.js';
import { HttpError, clampText, newId, sha256 } from './util.js';

/**
 * Serverless job model: POST /api/tryon stores a result document and hands
 * runJob() to waitUntil(), so generation continues in the same function
 * invocation after the 202 response. Progress lives in the database, so any
 * instance can answer the extension's polling requests.
 */
const STAGES = {
  queued: { label: 'Starting', progress: 5 },
  preparing: { label: 'Preparing your photos and product images', progress: 12 },
  uploading: { label: 'Sending images to the AI securely', progress: 25 },
  generating: { label: 'Generating your try-on', progress: 35 },
  saving: { label: 'Finishing up', progress: 96 },
  done: { label: 'Done', progress: 100 },
  failed: { label: 'Failed', progress: 100 },
};

const DEFAULT_GEN_MS = providerName === 'mock' ? 3000 : 20000;
let avgCache = { at: 0, value: DEFAULT_GEN_MS };

async function avgGenerationMs() {
  if (Date.now() - avgCache.at < 60_000) return avgCache.value;
  const done = (await db.find('results', { provider: providerName, status: 'done' }))
    .filter((r) => r.generationMs)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10);
  const value = done.length ? done.reduce((s, r) => s + r.generationMs, 0) / done.length : DEFAULT_GEN_MS;
  avgCache = { at: Date.now(), value };
  return value;
}

/** Jobs whose function invocation died (timeout, crash) are marked failed when read. */
export async function checkStale(r) {
  if (['done', 'failed'].includes(r.status)) return r;
  const last = new Date(r.updatedAt || r.createdAt).getTime();
  if (Date.now() - last < config.staleJobMs) return r;
  return db.patch('results', r.id, {
    status: 'failed',
    stage: 'failed',
    error: { code: 'TIMEOUT', message: 'Generation took too long and was stopped. Please try again.', retryable: true },
  });
}

export async function publicResult(r) {
  let progress = STAGES[r.stage]?.progress ?? 0;
  let etaMs = null;
  if (r.stage === 'generating' && r.generationStartedAt) {
    const elapsed = Date.now() - r.generationStartedAt;
    const avg = await avgGenerationMs();
    progress = Math.round(35 + 57 * (1 - Math.exp(-elapsed / avg)));
    etaMs = Math.max(0, avg - elapsed);
  }
  return {
    id: r.id,
    status: r.status,
    stage: r.stage,
    stageLabel: STAGES[r.stage]?.label || r.stage,
    progress,
    etaMs,
    error: r.error || null,
    cached: Boolean(r.cached),
    profileId: r.profileId,
    items: r.items,
    scene: r.scene ? { key: r.scene.key, label: r.scene.label } : null,
    provider: r.provider,
    model: r.model,
    fast: r.fast,
    createdAt: r.createdAt,
    completedAt: r.completedAt || null,
    durationMs: r.durationMs || null,
    queuePosition: 0,
  };
}

async function sanitizeItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new HttpError(400, 'NO_ITEMS', 'Select at least one product.');
  if (rawItems.length > 4) throw new HttpError(400, 'TOO_MANY_ITEMS', 'An outfit can contain at most 4 products.');
  const { categories } = getCatalog();
  const items = [];
  for (const it of rawItems) {
    const imageIds = (Array.isArray(it.imageIds) ? it.imageIds : []).slice(0, 3).map(String);
    if (!imageIds.length) throw new HttpError(400, 'NO_PRODUCT_IMAGE', 'Each product needs at least one image.');
    const records = await Promise.all(imageIds.map((id) => db.get('productImages', id)));
    if (records.some((r) => !r)) throw new HttpError(400, 'UNKNOWN_PRODUCT_IMAGE', 'Product image not found - please re-select the product.');
    items.push({
      title: clampText(it.title, 200),
      category: categories[it.category] ? it.category : 'accessories',
      brand: clampText(it.brand, 80),
      color: clampText(it.color, 80),
      variant: clampText(it.variant, 120),
      description: clampText(it.description, 400),
      price: clampText(it.price, 40),
      pageUrl: clampText(it.pageUrl, 1000),
      breadcrumbs: (Array.isArray(it.breadcrumbs) ? it.breadcrumbs : []).slice(0, 6).map((b) => clampText(b, 60)),
      imageIds,
      imageShas: records.map((r) => r.sha256),
    });
  }
  return items;
}

/**
 * Validates the request and creates the result document.
 * Returns { job, run } - `run` is the generation promise factory for waitUntil (null when cached).
 */
export async function createTryOn(user, body) {
  const profile = await db.get('profiles', String(body.profileId || ''));
  if (!profile || profile.userId !== user.id) throw new HttpError(404, 'PROFILE_NOT_FOUND', 'Profile not found.');
  const items = await sanitizeItems(body.items);

  const photosBySlot = {};
  for (const p of await db.find('photos', { profileId: profile.id })) photosBySlot[p.slot] = p;
  const photos = selectProfilePhotos(photosBySlot, items);
  if (!photos) throw new HttpError(400, 'NO_PROFILE_PHOTOS', 'Add at least one photo to your profile first.');

  const scene = resolveScene(body.scene, items);
  const fast = Boolean(body.fast);

  const cacheKey = sha256(JSON.stringify({
    v: config.promptVersion,
    provider: providerName,
    model: modelName,
    fast,
    photos: [photos.primary, ...photos.supporting].map((p) => p.sha256),
    products: items.map((i) => [i.category, i.imageShas, i.variant]),
    scene: [scene.key, scene.prompt],
    profile: [profile.heightCm, profile.fitPreference, profile.notes],
  }));

  const mine = await db.find('results', { userId: user.id });
  if (!body.force) {
    const hit = mine.find((r) => r.cacheKey === cacheKey && r.status === 'done');
    if (hit) return { job: { ...(await publicResult(hit)), cached: true }, run: null };
  }

  const hourAgo = Date.now() - 3600_000;
  if (mine.filter((r) => new Date(r.createdAt).getTime() > hourAgo).length >= config.tryOnLimitPerHour) {
    throw new HttpError(429, 'RATE_LIMITED', `Try-on limit reached (${config.tryOnLimitPerHour} per hour). Please wait a little.`);
  }
  const running = (await Promise.all(mine.filter((r) => !['done', 'failed'].includes(r.status)).map(checkStale)))
    .filter((r) => !['done', 'failed'].includes(r.status));
  if (running.length >= config.maxRunningJobsPerUser) {
    throw new HttpError(429, 'TOO_MANY_JOBS', 'You already have try-ons in progress. Please wait for them to finish.');
  }

  const now = new Date().toISOString();
  const result = await db.put('results', {
    id: newId('r_'),
    userId: user.id,
    profileId: profile.id,
    status: 'queued',
    stage: 'queued',
    items: items.map(({ imageShas, ...rest }) => rest),
    scene,
    photoIds: [photos.primary.id, ...photos.supporting.map((p) => p.id)],
    provider: providerName,
    model: modelName,
    fast,
    cacheKey,
    createdAt: now,
    updatedAt: now,
  });
  return { job: await publicResult(result), run: () => runJob(result.id) };
}

async function resolveParts(result, parts) {
  return Promise.all(parts.map(async (p) => {
    if (!p.image) return p;
    if (p.image.kind === 'photo') {
      const photo = await db.get('photos', p.image.id);
      if (!photo) throw new HttpError(409, 'PHOTO_REMOVED', 'A profile photo was deleted during generation.');
      const buffer = await blobs.get(photo.blobKey);
      if (!buffer) throw new HttpError(409, 'PHOTO_REMOVED', 'A profile photo is missing from storage.');
      let cache = photo.providerCache?.[providerName] || null;
      return {
        image: {
          kind: 'photo',
          reusable: true,
          mime: 'image/jpeg',
          displayName: `profile-${photo.slot}`,
          buffer,
          cache: {
            get: () => cache,
            set: async (val) => {
              cache = val;
              await db.patch('photos', photo.id, { providerCache: { ...(photo.providerCache || {}), [providerName]: val } });
            },
          },
        },
      };
    }
    const rec = await db.get('productImages', p.image.id);
    const buffer = rec && (await blobs.get(rec.blobKey));
    if (!buffer) throw new HttpError(409, 'PRODUCT_IMAGE_MISSING', 'The product image expired from the cache. Please try again.');
    return { image: { kind: 'product', reusable: false, mime: 'image/jpeg', buffer } };
  }));
}

export async function runJob(id) {
  const started = Date.now();
  const setStage = (stage, extra = {}) =>
    db.patch('results', id, { stage, status: 'running', updatedAt: new Date().toISOString(), ...extra });

  try {
    const result = await db.get('results', id);
    if (!result) return;
    await setStage('preparing');
    const profile = await db.get('profiles', result.profileId);
    if (!profile) throw new HttpError(409, 'PROFILE_REMOVED', 'The profile was deleted.');
    const photos = await Promise.all(result.photoIds.map((pid) => db.get('photos', pid)));
    if (photos.some((p) => !p)) throw new HttpError(409, 'PHOTO_REMOVED', 'A profile photo was deleted during generation.');
    const parts = buildPrompt({ profile, photos: { primary: photos[0], supporting: photos.slice(1) }, items: result.items, scene: result.scene });
    const resolved = await resolveParts(result, parts);

    let genStart = 0;
    const out = await provider.generate(resolved, {
      fast: result.fast,
      items: result.items,
      deadline: started + config.jobBudgetMs,
      onStage: async (stage) => {
        if (stage === 'generating') genStart = Date.now();
        await setStage(stage, stage === 'generating' ? { generationStartedAt: genStart } : {});
      },
    });
    const generationMs = genStart ? Date.now() - genStart : null;

    await setStage('saving');
    const ext = out.mime.includes('jpeg') ? 'jpg' : 'png';
    const blobKey = keys.result(result.userId, id, ext);
    const thumbKey = keys.thumb(result.userId, id);
    const thumb = await sharp(out.buffer).resize({ width: 360, height: 480, fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
    await Promise.all([
      blobs.put(blobKey, out.buffer, out.mime),
      blobs.put(thumbKey, thumb, 'image/jpeg'),
    ]);

    await db.patch('results', id, {
      status: 'done',
      stage: 'done',
      ext,
      blobKey,
      thumbKey,
      model: out.model,
      // A fallback-model result must not satisfy future requests meant for the primary model.
      cacheKey: out.model === result.model ? result.cacheKey : `${result.cacheKey}|${out.model}`,
      generationMs,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    });
  } catch (err) {
    console.error(`[jobs] ${id} failed:`, err);
    await db.patch('results', id, {
      status: 'failed',
      stage: 'failed',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: {
        code: err.code || 'GENERATION_FAILED',
        message: err instanceof HttpError ? err.message : 'Something went wrong while generating the image. Please try again.',
        retryable: !['AI_BLOCKED', 'PROFILE_REMOVED', 'PHOTO_REMOVED', 'AI_AUTH', 'AI_QUOTA'].includes(err.code),
      },
    }).catch((e) => console.error('[jobs] could not record failure', e));
  }
}
