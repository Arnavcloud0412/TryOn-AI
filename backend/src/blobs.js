import fs from 'node:fs';
import path from 'node:path';
import { put, get, del, list } from '@vercel/blob';
import { config } from './config.js';

/**
 * Binary storage. Production: a PRIVATE Vercel Blob store (files are never publicly
 * addressable; the API streams them only to the authenticated owner).
 * Local development: files under DATA_DIR/blobs.
 *
 * Key layout:
 *   users/<userId>/photos/<photoId>.jpg
 *   users/<userId>/results/<resultId>.<ext>  and  <resultId>_thumb.jpg
 *   products/<imageId>.jpg                     (public catalogue images, shared cache)
 */
export const keys = {
  userPrefix: (userId) => `users/${userId}/`,
  photo: (userId, photoId) => `users/${userId}/photos/${photoId}.jpg`,
  result: (userId, resultId, ext) => `users/${userId}/results/${resultId}.${ext}`,
  thumb: (userId, resultId) => `users/${userId}/results/${resultId}_thumb.jpg`,
  product: (imageId) => `products/${imageId}.jpg`,
};

const vercelBlob = {
  async put(key, buffer, contentType) {
    await put(key, buffer, { access: 'private', contentType, addRandomSuffix: false, allowOverwrite: true });
  },
  async get(key) {
    const r = await get(key, { access: 'private' });
    if (!r || r.statusCode !== 200) return null;
    return Buffer.from(await new Response(r.stream).arrayBuffer());
  },
  async del(keyList) {
    const k = keyList.filter(Boolean);
    if (k.length) await del(k).catch((err) => console.warn('[blob] delete failed', err.message));
  },
  async delPrefix(prefix) {
    let cursor;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      if (page.blobs.length) await del(page.blobs.map((b) => b.url));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  },
};

const root = path.join(config.dataDir, 'blobs');
const localPath = (key) => path.join(root, ...key.split('/'));

const localBlob = {
  async put(key, buffer) {
    await fs.promises.mkdir(path.dirname(localPath(key)), { recursive: true });
    await fs.promises.writeFile(localPath(key), buffer);
  },
  async get(key) {
    return fs.promises.readFile(localPath(key)).catch(() => null);
  },
  async del(keyList) {
    await Promise.all(keyList.filter(Boolean).map((k) => fs.promises.rm(localPath(k), { force: true })));
  },
  async delPrefix(prefix) {
    await fs.promises.rm(localPath(prefix.replace(/\/$/, '')), { recursive: true, force: true });
  },
};

if (config.onVercel && !config.useBlob) {
  console.error('[blob] No Blob store connected. Create a private Vercel Blob store and connect it to this project.');
}

export const blobs = config.useBlob ? vercelBlob : localBlob;
export const blobDriver = config.useBlob ? 'vercel-blob-private' : 'local-disk';
