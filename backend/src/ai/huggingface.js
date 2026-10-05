import { Client, handle_file } from '@gradio/client';
import { HttpError } from '../util.js';

/**
 * Free provider: the public IDM-VTON Space on Hugging Face (diffusion-based
 * garment try-on, runs on Hugging Face ZeroGPU). No billing required; an optional
 * free HF_TOKEN raises the GPU quota compared to anonymous use.
 *
 * Limitations vs. Gemini: upper-body garments only (the Space's automatic mask is
 * upper-body), one garment per image, and the person's original background is kept.
 */
const SPACE = process.env.HF_TRYON_SPACE || 'yisol/IDM-VTON';
const TOKEN = (process.env.HF_TOKEN || '').trim() || undefined;

export const SUPPORTED_CATEGORIES = ['tshirt', 'shirt', 'jacket'];
export const model = `hf:${SPACE}`;

let clientPromise = null;
function client() {
  if (!clientPromise) {
    clientPromise = Client.connect(SPACE, TOKEN ? { token: TOKEN } : {}).catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

function friendly(err) {
  const msg = String(err?.message || err?.title || JSON.stringify(err) || '');
  if (/quota|ZeroGPU|exceeded|GPU task/i.test(msg)) {
    return new HttpError(429, 'AI_QUOTA', `The free Hugging Face GPU quota is used up for now. Add a free HF_TOKEN on the server or try again later. (${msg.slice(0, 160)})`);
  }
  if (/sleeping|building|paused|runtime error/i.test(msg)) {
    return new HttpError(503, 'AI_UNAVAILABLE', 'The free try-on model is starting up or unavailable. Please try again in a minute.');
  }
  return new HttpError(502, 'AI_ERROR', `Free try-on model error: ${msg.slice(0, 200)}`);
}

/**
 * @param {Array} parts resolved prompt parts (person photos first, then product images)
 * @param {{fast?:boolean, onStage?:Function, items?:Array}} opts
 */
export async function generate(parts, { fast = false, onStage = async () => {}, items = [] } = {}) {
  const item = items.find((i) => SUPPORTED_CATEGORIES.includes(i.category));
  if (!item) {
    throw new HttpError(422, 'UNSUPPORTED_CATEGORY', 'The free try-on model supports T-shirts, tops, shirts and jackets. Pick one of those (or enable Gemini billing for all categories).');
  }
  const person = parts.find((p) => p.image?.kind === 'photo');
  const itemIndex = items.indexOf(item);
  const garment = parts.filter((p) => p.image?.kind === 'product')[
    items.slice(0, itemIndex).reduce((n, i) => n + i.imageIds.length, 0)
  ];
  if (!person || !garment) throw new HttpError(400, 'MISSING_IMAGES', 'Missing person or product image.');

  await onStage('uploading');
  let result;
  try {
    const c = await client();
    await onStage('generating');
    result = await c.predict('/tryon', {
      dict: { background: handle_file(new Blob([person.image.buffer], { type: 'image/jpeg' })), layers: [], composite: null },
      garm_img: handle_file(new Blob([garment.image.buffer], { type: 'image/jpeg' })),
      garment_des: [item.color, item.title].filter(Boolean).join(' ').slice(0, 120) || 'garment',
      is_checked: true,
      is_checked_crop: true,
      denoise_steps: fast ? 20 : 30,
      seed: 42,
    });
  } catch (err) {
    throw friendly(err);
  }

  const url = result?.data?.[0]?.url;
  if (!url) throw new HttpError(502, 'AI_NO_IMAGE', 'The free try-on model did not return an image.');
  const res = await fetch(url, { headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new HttpError(502, 'AI_NO_IMAGE', `Could not download the generated image (HTTP ${res.status}).`);
  return { buffer: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') || 'image/png', text: '', model };
}

export async function deleteRemoteFile() {}
