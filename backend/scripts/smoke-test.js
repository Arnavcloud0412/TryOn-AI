// End-to-end API smoke test: `npm run smoke` (server must be running).
// Registers a device, creates a profile, uploads a generated photo, uploads a
// product image, runs a try-on, polls to completion, checks caching and deletion.
import sharp from 'sharp';

const BASE = process.env.API || 'http://127.0.0.1:8787/api';
let token;

async function call(path, { method = 'GET', body, form } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.arrayBuffer();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const solid = (w, h, color) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
// REAL_IMAGES=1 uses real sample photos (needed for real AI models; flat colours suffice for the mock provider)
const SAMPLES = 'https://raw.githubusercontent.com/yisol/IDM-VTON/main/gradio_demo/example';
const sample = async (path) => Buffer.from(await (await fetch(`${SAMPLES}/${path}`)).arrayBuffer());
const personImage = () => (process.env.REAL_IMAGES ? sample('human/00034_00.jpg') : solid(800, 1200, '#c8a27a'));
const garmentImage = () => (process.env.REAL_IMAGES ? sample('cloth/04469_00.jpg') : solid(600, 700, '#1e40af'));
const step = (msg) => console.log(`✔ ${msg}`);

const health = await call('/health');
step(`health: provider=${health.provider}`);
const cfg = await call('/config');
step(`config: ${Object.keys(cfg.categories).length} categories, ${Object.keys(cfg.photoSlots).length} photo slots`);

token = (await call('/auth/register', { method: 'POST' })).token;
step('registered device');

const profile = await call('/profiles', { method: 'POST', body: { name: 'Smoke Test', heightCm: 175 } });
step(`created profile ${profile.id}`);

const fd = new FormData();
fd.append('photo', new Blob([await personImage()], { type: 'image/jpeg' }), 'full.jpg');
const withPhoto = await call(`/profiles/${profile.id}/photos/full`, { method: 'PUT', form: fd });
step(`uploaded full-body photo (${withPhoto.photos[0].width}x${withPhoto.photos[0].height})`);

const pf = new FormData();
pf.append('image', new Blob([await garmentImage()], { type: 'image/jpeg' }), 'tee.jpg');
pf.append('sourceUrl', 'https://example.com/blue-tee.jpg');
const img = await call('/product-images/upload', { method: 'POST', form: pf });
step(`uploaded product image ${img.id}`);

const blocked = await call('/product-images', { method: 'POST', body: { images: [{ url: 'http://127.0.0.1/secret.png' }] } });
if (blocked.results[0].ok) throw new Error('SSRF protection failed');
step('SSRF protection rejects private addresses');

const body = {
  profileId: profile.id,
  items: [{ title: 'Classic Blue Beach T-Shirt', category: 'tshirt', imageIds: [img.id], pageUrl: 'https://example.com/p/1' }],
  scene: { mode: 'auto' },
};
let job = await call('/tryon', { method: 'POST', body });
step(`queued try-on ${job.id} (scene: ${job.scene.label})`);
while (!['done', 'failed'].includes(job.status)) {
  await new Promise((r) => setTimeout(r, 700));
  job = await call(`/tryon/${job.id}`);
  process.stdout.write(`  … ${job.stage} ${job.progress}%\r`);
}
if (job.status !== 'done') throw new Error(`job failed: ${JSON.stringify(job.error)}`);
step(`try-on done in ${job.durationMs} ms (model: ${job.model})`);

const image = await call(`/results/${job.id}/image`);
step(`result image ${image.byteLength} bytes`);
if (process.env.SAVE_RESULT) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(process.env.SAVE_RESULT, Buffer.from(image));
  step(`saved result to ${process.env.SAVE_RESULT}`);
}

const again = await call('/tryon', { method: 'POST', body });
if (again.cached) step('identical request served from cache');
else if (String(job.model).startsWith('hf:')) step('fallback-model result is not reused for primary-model requests (expected)');
else throw new Error('expected cached result');

const list = await call('/results');
step(`wardrobe has ${list.results.length} result(s)`);

await call('/me', { method: 'DELETE' });
try {
  await call('/profiles');
  throw new Error('token should be revoked');
} catch (err) {
  if (!String(err.message).includes('401')) throw err;
}
step('delete-all-data removed the account');
console.log('\nAll smoke tests passed.');
