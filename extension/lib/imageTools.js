// Client-side image helpers.

/**
 * Downscale and re-encode a user photo before upload (smaller upload, EXIF
 * orientation applied, metadata dropped). Also returns simple quality hints.
 */
export async function prepareProfilePhoto(file, maxEdge = 1600) {
  if (!file.type.startsWith('image/')) throw new Error('Please choose an image file (JPEG, PNG, WebP or HEIC).');
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);

  const hints = [];
  if (Math.min(bmp.width, bmp.height) < 600) hints.push('This photo is quite small - a higher-resolution photo gives better results.');
  const sample = ctx.getImageData(0, 0, w, h).data;
  let lum = 0;
  let n = 0;
  for (let i = 0; i < sample.length; i += 4 * 97) {
    lum += 0.299 * sample[i] + 0.587 * sample[i + 1] + 0.114 * sample[i + 2];
    n += 1;
  }
  const mean = lum / n;
  if (mean < 60) hints.push('The photo looks dark - try brighter, even lighting.');
  if (mean > 235) hints.push('The photo looks over-exposed.');
  bmp.close();

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  return { blob, width: w, height: h, hints };
}

/** Downscale any image blob to a JPEG that fits comfortably under the 4.5 MB serverless body limit. */
export async function shrinkImageBlob(blob, maxEdge = 1600) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
}

const blobs = new Map();

/** Fetch a product image with the extension's host permission (bypasses CORS, uses no page cookies). */
export function fetchImageBlob(url) {
  if (!blobs.has(url)) {
    const p = fetch(url, { credentials: 'omit', referrerPolicy: 'strict-origin-when-cross-origin' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((b) => {
        if (!b.type.startsWith('image/') && b.type !== 'application/octet-stream' && b.type !== '') throw new Error('Not an image');
        return b;
      })
      .catch((err) => {
        blobs.delete(url);
        throw err;
      });
    blobs.set(url, p);
  }
  return blobs.get(url);
}

/**
 * Score how suitable a product image is as try-on input. Product-only shots on a
 * plain, light background are ideal; busy lifestyle photos are less reliable.
 */
export async function analyzeProductImage(url) {
  const blob = await fetchImageBlob(url);
  const bmp = await createImageBitmap(blob);
  const { width, height } = bmp;
  const S = 48;
  const canvas = new OffscreenCanvas(S, S);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, S, S);
  bmp.close();
  const d = ctx.getImageData(0, 0, S, S).data;
  const lumAt = (x, y) => {
    const i = (y * S + x) * 4;
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  };
  const border = [];
  const center = [];
  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      const edge = x < 3 || y < 3 || x >= S - 3 || y >= S - 3;
      if (edge) border.push(lumAt(x, y));
      else if (x > S / 4 && x < (3 * S) / 4 && y > S / 4 && y < (3 * S) / 4) center.push(lumAt(x, y));
    }
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const std = (a) => {
    const m = mean(a);
    return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
  };
  const bMean = mean(border);
  const bStd = std(border);
  const plain = bStd < 14;
  const contrast = Math.abs(mean(center) - bMean) > 12 || std(center) > 20;

  let bonus = 0;
  if (plain) bonus += 1.5;
  if (plain && bMean > 200) bonus += 0.8;
  if (!contrast) bonus -= 1.5;
  if (Math.min(width, height) >= 700) bonus += 0.7;
  else if (Math.min(width, height) < 300) bonus -= 1;
  const ratio = height / width;
  if (ratio > 3 || ratio < 0.35) bonus -= 2;

  return { width, height, plain, bonus };
}

/** Run async tasks with a concurrency limit. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (err) {
        out[idx] = { error: err };
      }
    }
  });
  await Promise.all(workers);
  return out;
}
