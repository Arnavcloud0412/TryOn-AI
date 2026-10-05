// Backend API client. The extension holds NO AI keys - only an anonymous
// device token issued by our own backend (stored in chrome.storage.local).

export const DEFAULT_BACKEND = 'https://tryon-ai-backend.vercel.app';

export class ApiError extends Error {
  constructor(status, code, message, retryable = true) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export async function getSettings() {
  const s = await chrome.storage.local.get(['backendUrl', 'token', 'fastMode']);
  return {
    backendUrl: (s.backendUrl || DEFAULT_BACKEND).replace(/\/+$/, ''),
    token: s.token || null,
    fastMode: Boolean(s.fastMode),
  };
}

export async function saveSettings(changes) {
  await chrome.storage.local.set(changes);
}

let registering = null;

async function register(base) {
  if (!registering) {
    registering = (async () => {
      const res = await rawFetch(`${base}/api/auth/register`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new ApiError(res.status, json.error?.code, json.error?.message || 'Registration failed');
      await chrome.storage.local.set({ token: json.token });
      return json.token;
    })().finally(() => { registering = null; });
  }
  return registering;
}

async function rawFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch {
    const base = url.split('/api/')[0];
    throw new ApiError(0, 'OFFLINE', `Cannot reach the TryOn AI server at ${base}. Is it running? (Settings → Server)`);
  }
}

/**
 * @param {string} path e.g. "/profiles"
 * @param {{method?:string, body?:object, form?:FormData, raw?:boolean}} opts
 */
export async function api(path, { method = 'GET', body, form, raw = false } = {}, retried = false) {
  const { backendUrl } = await getSettings();
  let { token } = await getSettings();
  if (!token) token = await register(backendUrl);

  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await rawFetch(`${backendUrl}/api${path}`, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });

  if (res.status === 401 && !retried) {
    await chrome.storage.local.remove('token');
    return api(path, { method, body, form, raw }, true);
  }
  if (raw && res.ok) return res;
  let json = null;
  try {
    json = await res.json();
  } catch { /* non-JSON */ }
  if (!res.ok) {
    throw new ApiError(res.status, json?.error?.code || 'HTTP_ERROR', json?.error?.message || `Request failed (HTTP ${res.status})`);
  }
  return json;
}

export async function publicGet(path) {
  const { backendUrl } = await getSettings();
  const res = await rawFetch(`${backendUrl}/api${path}`, {});
  if (!res.ok) throw new ApiError(res.status, 'HTTP_ERROR', `Request failed (HTTP ${res.status})`);
  return res.json();
}

// Authenticated images cannot use <img src> directly (no auth header), so they
// are fetched as blobs and cached as object URLs for the lifetime of the panel.
const blobCache = new Map();

export function authImage(path) {
  if (!blobCache.has(path)) {
    const p = api(path, { raw: true })
      .then((r) => r.blob())
      .then((b) => URL.createObjectURL(b))
      .catch((err) => {
        blobCache.delete(path);
        throw err;
      });
    blobCache.set(path, p);
  }
  return blobCache.get(path);
}

export function forgetImage(prefix) {
  for (const [key, p] of blobCache) {
    if (key.startsWith(prefix)) {
      p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
      blobCache.delete(key);
    }
  }
}
