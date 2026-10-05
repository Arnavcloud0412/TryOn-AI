import { config } from '../config.js';
import { HttpError, sleep } from '../util.js';

const { apiKey, baseUrl } = config.gemini;
const REUSE_MARGIN_MS = 2 * 3600 * 1000;

async function geminiFetch(url, init, timeoutMs = config.gemini.timeoutMs) {
  return fetch(url, {
    ...init,
    headers: { 'x-goog-api-key': apiKey, ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Upload an image to the Gemini Files API (resumable protocol) so that the same
 * profile photo is not re-sent on every try-on. Files expire after 48 h.
 */
async function uploadFile(buffer, mimeType, displayName) {
  const start = await geminiFetch(`${baseUrl}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buffer.length),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  }, 30_000);
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!start.ok || !uploadUrl) throw new Error(`Files API start failed (HTTP ${start.status})`);
  const res = await geminiFetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(buffer.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: buffer,
  }, 60_000);
  if (!res.ok) throw new Error(`Files API upload failed (HTTP ${res.status})`);
  const { file } = await res.json();
  return { name: file.name, uri: file.uri, expiresAt: file.expirationTime };
}

export async function deleteRemoteFile(cache) {
  if (!cache?.name || !apiKey) return;
  await geminiFetch(`${baseUrl}/v1beta/${cache.name}`, { method: 'DELETE' }, 15_000).catch(() => {});
}

/**
 * Resolve an image part. Reusable images (profile photos) go through the Files API
 * cache; one-off images are sent inline.
 */
async function toPart(image, { allowFileCache }) {
  if (allowFileCache && image.cache) {
    const cached = image.cache.get();
    if (cached && new Date(cached.expiresAt).getTime() - Date.now() > REUSE_MARGIN_MS) {
      return { fileData: { mimeType: image.mime, fileUri: cached.uri } };
    }
    try {
      const uploaded = await uploadFile(image.buffer, image.mime, image.displayName || 'tryon-profile-photo');
      await image.cache.set(uploaded);
      return { fileData: { mimeType: image.mime, fileUri: uploaded.uri } };
    } catch (err) {
      console.warn('[gemini] Files API unavailable, sending inline:', err.message);
    }
  }
  return { inlineData: { mimeType: image.mime, data: image.buffer.toString('base64') } };
}

function extractImage(json) {
  const blocked = json.promptFeedback?.blockReason;
  if (blocked) {
    throw new HttpError(422, 'AI_BLOCKED', `The AI provider declined this request (${blocked}). Try a different photo or product.`);
  }
  const cand = json.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const img = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
  const text = parts.filter((p) => p.text).map((p) => p.text).join(' ').trim();
  if (!img) {
    const reason = cand?.finishReason && cand.finishReason !== 'STOP' ? ` (${cand.finishReason})` : '';
    throw new HttpError(502, 'AI_NO_IMAGE', `The AI did not return an image${reason}.${text ? ` Model said: ${text.slice(0, 200)}` : ''}`);
  }
  const data = img.inlineData || img.inline_data;
  return { buffer: Buffer.from(data.data, 'base64'), mime: data.mimeType || data.mime_type || 'image/png', text };
}

/**
 * @param {Array<{text?:string,image?:object}>} parts resolved prompt parts
 * @param {{fast?:boolean,onStage?:Function,deadline?:number}} opts deadline = epoch ms the work must finish by
 */
export async function generate(parts, { fast = false, onStage = async () => {}, deadline = Date.now() + config.gemini.timeoutMs } = {}) {
  const model = fast ? config.gemini.fastModel : config.gemini.model;
  let useFileCache = true;
  let useImageConfig = true;
  const remaining = () => deadline - Date.now();
  const canRetry = (attempt) => attempt < 2 && remaining() > 45_000;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await onStage('uploading');
    const apiParts = [];
    for (const p of parts) {
      if (p.text) apiParts.push({ text: p.text });
      else apiParts.push(await toPart(p.image, { allowFileCache: useFileCache && p.image.reusable }));
    }

    await onStage('generating');
    const body = {
      contents: [{ role: 'user', parts: apiParts }],
      generationConfig: {
        responseModalities: ['IMAGE', 'TEXT'],
        ...(useImageConfig ? { imageConfig: { aspectRatio: '3:4' } } : {}),
      },
    };
    let res;
    try {
      res = await geminiFetch(`${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, Math.max(10_000, Math.min(config.gemini.timeoutMs, remaining())));
    } catch (err) {
      if (canRetry(attempt)) { await sleep(2000 * (attempt + 1)); continue; }
      throw new HttpError(504, 'AI_TIMEOUT', `The AI provider did not respond in time (${err.name}).`);
    }

    if (res.ok) return { ...extractImage(await res.json()), model };

    const errText = await res.text();
    let providerMsg = '';
    try {
      providerMsg = JSON.parse(errText).error?.message || '';
    } catch { /* non-JSON body */ }
    console.warn(`[gemini] HTTP ${res.status} (attempt ${attempt + 1}): ${providerMsg || errText.slice(0, 300)}`);
    if (res.status === 429 && /quota|limit:\s*0|billing/i.test(providerMsg)) {
      throw new HttpError(429, 'AI_QUOTA', `The AI provider quota is exhausted or not enabled for model ${model}. ${providerMsg.slice(0, 240)}`);
    }
    if (res.status === 400 && useImageConfig && /imageConfig|aspect/i.test(errText)) {
      useImageConfig = false;
      continue;
    }
    if ((res.status === 403 || res.status === 404 || res.status === 400) && useFileCache && /file/i.test(errText)) {
      useFileCache = false;
      await Promise.all(parts.map((p) => p.image?.cache?.set(null)));
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && canRetry(attempt)) {
      await sleep(3000 * (attempt + 1));
      continue;
    }
    if (res.status === 429) throw new HttpError(429, 'AI_RATE_LIMITED', 'The AI provider is busy (rate limit). Please try again in a minute.');
    if (res.status === 401 || res.status === 403) throw new HttpError(502, 'AI_AUTH', 'The server\'s AI API key is invalid or lacks access to the image model.');
    throw new HttpError(502, 'AI_ERROR', `AI provider error (HTTP ${res.status}): ${errText.slice(0, 300)}`);
  }
  throw new HttpError(502, 'AI_ERROR', 'AI generation failed after several attempts.');
}
