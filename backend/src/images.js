import dns from 'node:dns/promises';
import net from 'node:net';
import sharp from 'sharp';
import { config } from './config.js';
import { HttpError, sha256 } from './util.js';

/**
 * Normalise a user photo: apply EXIF rotation, then strip ALL metadata (GPS, camera
 * serials...) and downscale to a size the AI model actually benefits from.
 */
export async function normalizeProfilePhoto(buffer) {
  let img;
  try {
    img = sharp(buffer, { failOn: 'error' }).rotate();
    const meta = await img.metadata();
    if (!meta.width || !meta.height) throw new Error('no dimensions');
  } catch {
    throw new HttpError(400, 'INVALID_IMAGE', 'The uploaded file is not a valid image.');
  }
  const out = await img
    .resize({ width: config.images.profileMaxEdge, height: config.images.profileMaxEdge, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  const warnings = [];
  const minEdge = Math.min(out.info.width, out.info.height);
  if (minEdge < 400) warnings.push('Low resolution photo - results will be better with a larger, sharper image.');
  return { buffer: out.data, width: out.info.width, height: out.info.height, sha256: sha256(out.data), warnings };
}

/** Normalise a product image: transparent backgrounds become white, max 1024px, JPEG. */
export async function normalizeProductImage(buffer) {
  let out;
  try {
    out = await sharp(buffer, { failOn: 'error', animated: false })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({ width: config.images.productMaxEdge, height: config.images.productMaxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new HttpError(422, 'INVALID_PRODUCT_IMAGE', 'The product image could not be decoded.');
  }
  if (Math.min(out.info.width, out.info.height) < 80) {
    throw new HttpError(422, 'PRODUCT_IMAGE_TOO_SMALL', 'The product image is too small to use.');
  }
  return { buffer: out.data, width: out.info.width, height: out.info.height, sha256: sha256(out.data) };
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, 'INVALID_URL', 'Invalid image URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'INVALID_URL', 'Only http(s) image URLs are supported.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new HttpError(422, 'IMAGE_FETCH_FAILED', 'Could not resolve the image host.');
  if (addrs.some((a) => isPrivateAddress(a.address))) {
    throw new HttpError(400, 'INVALID_URL', 'Image URLs pointing to private networks are not allowed.');
  }
  return url;
}

/**
 * Download a public product image with SSRF protection, size limit, timeout and
 * manual redirect handling (each hop is re-validated).
 */
export async function downloadImage(rawUrl, referer) {
  let current = rawUrl;
  for (let hop = 0; hop < 4; hop += 1) {
    const url = await assertPublicUrl(current);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 TryOnAI/1.0',
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
        ...(referer ? { Referer: referer } : {}),
      },
    }).catch((err) => {
      throw new HttpError(422, 'IMAGE_FETCH_FAILED', `Could not download product image (${err.name}).`);
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), url).toString();
      continue;
    }
    if (!res.ok) throw new HttpError(422, 'IMAGE_FETCH_FAILED', `Product image request failed (HTTP ${res.status}).`);
    const type = res.headers.get('content-type') || '';
    if (type && !type.startsWith('image/') && !type.includes('octet-stream')) {
      throw new HttpError(422, 'IMAGE_FETCH_FAILED', `URL did not return an image (${type}).`);
    }
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > config.images.maxRemoteBytes) throw new HttpError(413, 'IMAGE_TOO_LARGE', 'Product image is too large.');
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > config.images.maxRemoteBytes) throw new HttpError(413, 'IMAGE_TOO_LARGE', 'Product image is too large.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new HttpError(422, 'IMAGE_FETCH_FAILED', 'Too many redirects while downloading the product image.');
}

/** Build a labelled side-by-side composite (used by the mock provider). */
export async function sideBySide(personBuf, productBufs, label) {
  const h = 768;
  const person = await sharp(personBuf).resize({ height: h, width: 576, fit: 'cover' }).toBuffer();
  const thumbs = await Promise.all(
    productBufs.slice(0, 3).map((b) =>
      sharp(b).resize({ width: 256, height: Math.floor(h / Math.min(productBufs.length, 3)), fit: 'contain', background: '#ffffff' }).toBuffer(),
    ),
  );
  const slotH = Math.floor(h / Math.max(thumbs.length, 1));
  const esc = (s) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const banner = Buffer.from(
    `<svg width="832" height="56"><rect width="832" height="56" fill="rgba(17,24,39,0.82)"/>
     <text x="16" y="36" font-family="Arial" font-size="22" fill="#fff">${esc(label)}</text></svg>`,
  );
  return sharp({ create: { width: 832, height: h, channels: 3, background: '#ffffff' } })
    .composite([
      { input: person, left: 0, top: 0 },
      ...thumbs.map((t, i) => ({ input: t, left: 576, top: i * slotH })),
      { input: banner, left: 0, top: h - 56 },
    ])
    .png()
    .toBuffer();
}
