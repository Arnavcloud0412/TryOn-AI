import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { blobs, keys } from '../blobs.js';
import { downloadImage, normalizeProductImage } from '../images.js';
import { HttpError, ah, sha256 } from '../util.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.images.maxUploadBytes, files: 1 } });

const publicImage = (r, cached = true) => ({ id: r.id, width: r.width, height: r.height, cached });
const idForUrl = (url) => `i_${sha256(url).slice(0, 32)}`;

/**
 * Product images are public catalogue images, cached by URL (database record +
 * private blob) so each product image is downloaded and resized only once.
 */
async function fetchAndCache(url, referer) {
  const id = idForUrl(url);
  const existing = await db.get('productImages', id);
  if (existing && Date.now() - existing.fetchedAt < config.images.productCacheTtlMs) return publicImage(existing);
  const raw = await downloadImage(url, referer);
  const norm = await normalizeProductImage(raw);
  const rec = {
    id, sourceUrl: url, origin: 'fetch', blobKey: keys.product(id), sha256: norm.sha256, width: norm.width, height: norm.height, fetchedAt: Date.now(),
  };
  await blobs.put(rec.blobKey, norm.buffer, 'image/jpeg');
  await db.put('productImages', rec);
  return publicImage(rec, false);
}

router.post('/product-images', ah(async (req, res) => {
  const list = Array.isArray(req.body.images) ? req.body.images.slice(0, 8) : [];
  if (!list.length) throw new HttpError(400, 'NO_IMAGES', 'Provide images: [{ url, referer }].');
  const results = await Promise.all(list.map(async ({ url, referer }) => {
    try {
      return { url, ok: true, ...(await fetchAndCache(String(url), referer ? String(referer) : undefined)) };
    } catch (err) {
      return { url, ok: false, error: { code: err.code || 'IMAGE_FETCH_FAILED', message: err.message } };
    }
  }));
  res.json({ results });
}));

/** Fallback when the server cannot reach the image (e.g. hotlink protection): the extension uploads the bytes itself. */
router.post('/product-images/upload', upload.single('image'), ah(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'NO_FILE', 'Attach the product image in the "image" field.');
  const norm = await normalizeProductImage(req.file.buffer);
  const sourceUrl = req.body.sourceUrl ? String(req.body.sourceUrl).slice(0, 2000) : null;
  const id = sourceUrl ? idForUrl(sourceUrl) : `i_${norm.sha256.slice(0, 32)}`;
  const rec = {
    id, sourceUrl, origin: 'upload', blobKey: keys.product(id), sha256: norm.sha256, width: norm.width, height: norm.height, fetchedAt: Date.now(),
  };
  await blobs.put(rec.blobKey, norm.buffer, 'image/jpeg');
  await db.put('productImages', rec);
  res.json(publicImage(rec, false));
}));

router.get('/product-images/:id', ah(async (req, res) => {
  const rec = await db.get('productImages', req.params.id);
  const buffer = rec && (await blobs.get(rec.blobKey));
  if (!buffer) throw new HttpError(404, 'NOT_FOUND', 'Image not found.');
  res.set('Cache-Control', 'private, max-age=86400');
  res.type('image/jpeg').send(buffer);
}));

export default router;
