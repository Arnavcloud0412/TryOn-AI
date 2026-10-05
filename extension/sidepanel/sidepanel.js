import { api, authImage, forgetImage, getSettings, saveSettings, publicGet, DEFAULT_BACKEND } from '../lib/api.js';
import { classify } from '../lib/classify.js';
import { prepareProfilePhoto, analyzeProductImage, fetchImageBlob, shrinkImageBlob, mapLimit } from '../lib/imageTools.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = {
  view: 'tryon',
  config: null,
  online: null,
  connError: '',
  profiles: [],
  activeProfileId: null,
  me: null,
  tab: null,
  page: null,
  products: [],
  known: {},
  scanning: false,
  scanError: null,
  selectedId: null,
  sel: {},
  outfit: [],
  scene: { mode: 'auto', text: '' },
  fast: false,
  job: null,
  jobView: null,
  lastBody: null,
  results: [],
  compare: [],
  uploading: {},
};

// ---------------------------------------------------------------- utilities

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isErr ? ' err' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), isErr ? 5000 : 2600);
}

const activeProfile = () => state.profiles.find((p) => p.id === state.activeProfileId) || null;
const slotLabel = (slot) => state.config?.photoSlots?.[slot]?.label || slot;
const catLabel = (key) => state.config?.categories?.[key]?.label || key;
const photoPath = (profile, slot) => {
  const ph = profile.photos.find((p) => p.slot === slot);
  return ph ? `/profiles/${profile.id}/photos/${slot}?v=${encodeURIComponent(ph.updatedAt)}` : null;
};

function hydrateAuthImages(root = document) {
  $$('img[data-auth-src]', root).forEach((img) => {
    const path = img.getAttribute('data-auth-src');
    img.removeAttribute('data-auth-src');
    authImage(path).then((u) => { img.src = u; }).catch(() => { img.alt = 'Image unavailable'; });
  });
}

function sourceLabel(src = '') {
  if (src.startsWith('json-ld')) return 'Structured data';
  if (src === 'microdata') return 'Microdata';
  if (src === 'meta') return 'Page metadata';
  if (src === 'listing') return 'Listing card';
  if (src === 'context-menu') return 'Right-click';
  return 'Page layout';
}

const fmtMs = (ms) => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10}s`);

// ---------------------------------------------------------------- connection & profiles

async function connect() {
  try {
    state.config = await publicGet('/config');
    state.online = true;
    state.connError = '';
    await loadProfiles();
  } catch (err) {
    state.online = false;
    state.connError = err.message;
  }
  const dot = $('#connDot');
  dot.className = `conn-dot ${state.online ? 'ok' : 'bad'}`;
  dot.title = state.online ? `Connected · AI: ${state.config.provider} (${state.config.model})` : state.connError;
}

async function loadProfiles() {
  const r = await api('/profiles');
  state.profiles = r.profiles;
  state.activeProfileId = state.profiles.some((p) => p.id === r.activeProfileId) ? r.activeProfileId : state.profiles[0]?.id || null;
  renderSwitcher();
}

function renderSwitcher() {
  const sw = $('#profileSwitcher');
  sw.innerHTML = state.profiles.map((p) => `<option value="${esc(p.id)}" ${p.id === state.activeProfileId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')
    + '<option value="__new">+ New profile…</option>';
  sw.classList.toggle('hidden', !state.online);
}

async function setActiveProfile(id) {
  state.activeProfileId = id;
  renderSwitcher();
  render();
  api('/me', { method: 'PATCH', body: { activeProfileId: id } }).catch(() => {});
}

async function createProfile(name) {
  const p = await api('/profiles', { method: 'POST', body: { name: name || `Profile ${state.profiles.length + 1}` } });
  state.profiles.push(p);
  await setActiveProfile(p.id);
  return p;
}

// ---------------------------------------------------------------- page scanning

let scanTimer = null;
function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, 400);
}

function ensureSel(p) {
  if (state.sel[p.id]) return state.sel[p.id];
  const c = classify(p, state.config?.categories);
  state.sel[p.id] = {
    category: c.key,
    autoCategory: c.key,
    confidence: c.confidence,
    images: p.images.slice(0, 1).map((i) => i.url),
    bestUrl: p.images[0]?.url,
    touched: false,
    variant: null,
    analyzed: false,
  };
  return state.sel[p.id];
}

async function scan() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab || null;
  const pinned = state.products.filter((p) => p.source === 'context-menu' && p.tabId === tab?.id);
  if (!tab?.url || !/^https?:/i.test(tab.url)) {
    state.page = null;
    state.products = pinned;
    state.scanError = 'Open a product or category page on a shopping website - products will appear here automatically.';
    renderTryOn();
    return;
  }
  state.scanning = true;
  state.scanError = null;
  renderTryOn();
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/detector.js'] });
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.__tryOnAI.detect() });
    state.page = result.page;
    state.products = [...pinned, ...result.products];
    for (const p of state.products) {
      state.known[p.id] = p;
      ensureSel(p);
    }
    if (!state.products.some((p) => p.id === state.selectedId)) state.selectedId = state.products[0]?.id || null;
    if (state.selectedId) selectProduct(state.selectedId, { highlight: false });
  } catch (err) {
    state.page = null;
    state.products = pinned;
    state.scanError = /cannot access|cannot be scripted|extensions gallery|chrome:\/\//i.test(err.message)
      ? 'Chrome does not allow extensions to read this page. Open a regular shopping website.'
      : `Could not scan this page (${err.message}).`;
  } finally {
    state.scanning = false;
    renderTryOn();
  }
}

async function checkPendingImage() {
  const { pendingImage } = await chrome.storage.session.get('pendingImage');
  if (!pendingImage || Date.now() - pendingImage.at > 5 * 60_000) return;
  await chrome.storage.session.remove('pendingImage');
  const id = `ctx-${Math.abs([...pendingImage.srcUrl].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))}`;
  const product = {
    id,
    title: pendingImage.title || 'Selected image',
    brand: '',
    description: '',
    price: '',
    link: pendingImage.pageUrl,
    source: 'context-menu',
    tabId: pendingImage.tabId,
    isPrimary: true,
    breadcrumbs: [],
    images: [{ url: pendingImage.srcUrl, score: 5 }],
    variants: [],
  };
  state.products = [product, ...state.products.filter((p) => p.id !== id)];
  state.known[id] = product;
  ensureSel(product);
  switchView('tryon');
  state.jobView = null;
  selectProduct(id, { highlight: false });
  toast('Image added - pick the category and press Try On');
}

function highlightOnPage(id) {
  if (!state.tab || id.startsWith('ctx-')) return;
  chrome.scripting.executeScript({
    target: { tabId: state.tab.id },
    func: (pid) => globalThis.__tryOnAI?.highlight(pid),
    args: [id],
  }).catch(() => {});
}

function findImage(p, url) {
  return p.images.find((i) => i.url === url)
    || p.variants?.flatMap((v) => v.images).find((i) => i.url === url)
    || { url };
}

/** Automatic best-image selection: detector score + pixel analysis (plain background, resolution, aspect). */
async function autoPickBest(p) {
  const sel = state.sel[p.id];
  if (!sel || sel.analyzed || !p.images.length) return;
  sel.analyzed = true;
  const candidates = p.images.slice(0, 6);
  const analyses = await mapLimit(candidates, 3, async (img) => {
    try {
      return await analyzeProductImage(img.url);
    } catch {
      if (!img.fallbackUrl) throw new Error('unreachable');
      const r = await analyzeProductImage(img.fallbackUrl);
      img.url = img.fallbackUrl;
      img.fallbackUrl = null;
      return r;
    }
  });
  let best = null;
  candidates.forEach((img, i) => {
    const a = analyses[i];
    img.analysis = a?.error ? null : a;
    const score = (img.score || 0) + (a?.error ? -4 : a.bonus);
    if (!best || score > best.score) best = { url: img.url, score, plain: a?.plain };
  });
  if (best) {
    sel.bestUrl = best.url;
    sel.bestPlain = best.plain;
    if (!sel.touched) sel.images = [best.url];
    prefetchImage(p, best.url);
  }
  if (state.selectedId === p.id && state.view === 'tryon' && !state.jobView) renderTryOn();
}

function selectProduct(id, { highlight = true } = {}) {
  state.selectedId = id;
  const p = state.known[id];
  if (!p) return;
  if (highlight) highlightOnPage(id);
  autoPickBest(p);
  renderTryOn();
}

// ---------------------------------------------------------------- product image preparation (cached)

const prepared = new Map();

/**
 * Get a backend image id for a product image URL. The server fetches & caches it;
 * if the server can't reach it (hotlink protection etc.) the extension fetches the
 * bytes itself and uploads them.
 */
function prepareImage(img, referer) {
  if (!prepared.has(img.url)) {
    const task = (async () => {
      const urls = [img.url, img.fallbackUrl].filter(Boolean);
      let lastErr = null;
      for (const url of urls) {
        const r = await api('/product-images', { method: 'POST', body: { images: [{ url, referer }] } });
        if (r.results[0]?.ok) return r.results[0].id;
        lastErr = r.results[0]?.error?.message;
      }
      for (const url of urls) {
        try {
          const blob = await shrinkImageBlob(await fetchImageBlob(url));
          const fd = new FormData();
          fd.append('image', blob, 'product-image');
          fd.append('sourceUrl', url);
          return (await api('/product-images/upload', { method: 'POST', form: fd })).id;
        } catch (err) {
          lastErr = err.message;
        }
      }
      throw new Error(`Couldn't load the product image${lastErr ? ` (${lastErr})` : ''}.`);
    })();
    task.catch(() => prepared.delete(img.url));
    prepared.set(img.url, task);
  }
  return prepared.get(img.url);
}

function prefetchImage(p, url) {
  if (state.online) prepareImage(findImage(p, url), p.link || state.page?.url).catch(() => {});
}

// ---------------------------------------------------------------- try-on jobs

let pollTimer = null;

async function startTryOn({ force = false, body = null } = {}) {
  const profile = activeProfile();
  if (!profile || !profile.photos.length) {
    toast('Add at least one photo to your profile first', true);
    switchView('profile');
    return;
  }
  const ids = state.outfit.length ? state.outfit : [state.selectedId];
  const products = ids.map((id) => state.known[id]).filter(Boolean);
  if (!body && !products.length) return;

  clearTimeout(pollTimer);
  state.jobView = 'progress';
  state.job = {
    status: 'running',
    stage: 'preparing',
    stageLabel: 'Getting product images',
    progress: 6,
    previewUrl: products[0] ? state.sel[products[0].id].images[0] || products[0].images[0]?.url : null,
    startedAt: Date.now(),
  };
  renderTryOn();

  try {
    if (!body) {
      const items = await Promise.all(products.map(async (p) => {
        const sel = state.sel[p.id];
        const urls = (sel.images.length ? sel.images : [p.images[0].url]).slice(0, 3);
        const imageIds = await Promise.all(urls.map((u) => prepareImage(findImage(p, u), p.link || state.page?.url)));
        return {
          title: p.title,
          category: sel.category,
          brand: p.brand,
          color: sel.variant?.color || p.color,
          variant: sel.variant?.name || '',
          description: p.description,
          price: p.price,
          pageUrl: p.link,
          breadcrumbs: p.breadcrumbs || [],
          imageIds,
        };
      }));
      body = { profileId: profile.id, items, scene: { ...state.scene }, fast: state.fast };
    }
    state.lastBody = body;
    const job = await api('/tryon', { method: 'POST', body: { ...body, force } });
    job.previewUrl = state.job.previewUrl;
    job.startedAt = state.job.startedAt;
    handleJob(job);
  } catch (err) {
    state.job = { status: 'failed', error: { message: err.message, retryable: err.retryable !== false } };
    renderTryOn();
  }
}

function handleJob(job) {
  const prev = state.job || {};
  state.job = { ...job, previewUrl: job.previewUrl || prev.previewUrl, startedAt: job.startedAt || prev.startedAt || Date.now() };
  chrome.storage.session.set({ jobId: job.status === 'done' || job.status === 'failed' ? null : job.id });
  if (job.status === 'done') {
    if (state.jobView === 'progress') state.jobView = 'result';
    else if (!state.jobView) toast('Your try-on is ready - open it from the banner or Wardrobe');
    state.results = [];
  } else if (job.status !== 'failed') {
    pollTimer = setTimeout(() => poll(job.id), 1500);
  }
  if (state.view === 'tryon') renderTryOn();
}

async function poll(id) {
  try {
    handleJob(await api(`/tryon/${id}`));
  } catch (err) {
    if (err.status === 0) {
      pollTimer = setTimeout(() => poll(id), 3000);
    } else {
      state.job = { status: 'failed', error: { message: err.message, retryable: true } };
      renderTryOn();
    }
  }
}

async function resumeJob() {
  const { jobId } = await chrome.storage.session.get('jobId');
  if (!jobId || !state.online) return;
  try {
    const job = await api(`/tryon/${jobId}`);
    state.jobView = job.status === 'done' ? null : 'progress';
    handleJob(job);
  } catch { /* gone */ }
}

function bodyFromResult(r) {
  return {
    profileId: r.profileId,
    items: r.items,
    scene: { mode: ['custom'].includes(r.scene?.key) ? 'auto' : r.scene?.key || 'auto' },
    fast: Boolean(r.fast),
  };
}

function openResult(r) {
  clearTimeout(pollTimer);
  state.job = r;
  state.lastBody = bodyFromResult(r);
  state.jobView = 'result';
  switchView('tryon');
}

async function deleteResult(id) {
  await api(`/results/${id}`, { method: 'DELETE' });
  forgetImage(`/results/${id}`);
  state.results = state.results.filter((r) => r.id !== id);
  state.compare = state.compare.filter((x) => x !== id);
  toast('Result deleted');
}

// ---------------------------------------------------------------- rendering: Try On

function render() {
  renderTryOn();
  if (state.view === 'profile') renderProfile();
  if (state.view === 'wardrobe') renderWardrobe();
  if (state.view === 'settings') renderSettings();
}

function offlineCard() {
  return `<div class="callout err"><h3>Server not reachable</h3><p>${esc(state.connError)}</p>
    <div class="btn-row"><button class="btn sm" data-act="reconnect">Retry</button><button class="btn sm" data-act="goto" data-view="settings">Server settings</button></div></div>`;
}

function renderTryOn() {
  const root = $('#view-tryon');
  if (state.view !== 'tryon') return renderActionBar();
  if (state.online === false) {
    root.innerHTML = offlineCard();
    return renderActionBar();
  }
  if (state.jobView === 'progress' && state.job?.status !== 'failed' && $('.progress-wrap', root)) {
    const p = progressParts();
    $('#pgStage').textContent = p.stage;
    $('#pgBar').style.width = `${p.pct}%`;
    $('#pgMeta').textContent = p.meta;
    $('#pgTip').textContent = p.tip;
    return renderActionBar();
  }
  if (state.jobView === 'progress') root.innerHTML = progressHtml();
  else if (state.jobView === 'result') root.innerHTML = resultHtml();
  else root.innerHTML = productsHtml();
  hydrateAuthImages(root);
  renderActionBar();
}

function profileGateHtml() {
  const profile = activeProfile();
  if (!state.profiles.length) {
    return `<div class="callout"><h3>👋 Welcome! Create your digital profile</h3>
      <p>Add a few photos of yourself once, then try on products from any shopping site.</p>
      <button class="btn primary sm" data-act="goto" data-view="profile">Create profile</button></div>`;
  }
  if (profile && !profile.photos.length) {
    return `<div class="callout warn"><h3>Add your photos</h3><p>Your profile "${esc(profile.name)}" has no photos yet.</p>
      <button class="btn primary sm" data-act="goto" data-view="profile">Add photos</button></div>`;
  }
  return '';
}

function jobBannerHtml() {
  const j = state.job;
  if (!j || state.jobView) return '';
  if (j.status === 'done') {
    return `<div class="callout row between"><span>✅ Your try-on is ready</span><button class="btn sm primary" data-act="show-result">View</button></div>`;
  }
  if (j.status !== 'failed') {
    return `<div class="callout row between"><span class="row"><span class="spinner"></span> Generating… ${j.progress || 0}%</span><button class="btn sm" data-act="show-progress">Show</button></div>`;
  }
  return '';
}

function productsHtml() {
  const page = state.page;
  let head = '';
  if (state.scanning) {
    head = '<div class="card row"><span class="spinner"></span><span>Scanning this page for products…</span></div>';
  } else if (page) {
    const typeLabel = { product: 'Product page', 'product+related': 'Product page + related items', listing: 'Listing page', unknown: 'No products found' }[page.type] || page.type;
    head = `<div class="card"><div class="page-head">
        <img class="favicon" src="${esc(state.tab?.favIconUrl || '../icons/icon16.png')}" alt="" />
        <div class="grow"><div class="page-host">${esc(page.host)}</div>
        <div class="small muted">${esc(typeLabel)} · ${state.products.length} product${state.products.length === 1 ? '' : 's'}</div></div>
        <button class="btn sm" data-act="rescan" title="Scan the page again">↻ Rescan</button></div></div>`;
  } else if (state.scanError) {
    head = `<div class="callout warn"><p>${esc(state.scanError)}</p><button class="btn sm" data-act="rescan">↻ Try again</button></div>`;
  }

  const outfitOther = state.outfit.filter((id) => !state.products.some((p) => p.id === id));
  const outfitHtml = state.outfit.length
    ? `<div class="card"><div class="row between"><h3>👗 Outfit (${state.outfit.length}/4)</h3><button class="btn ghost sm" data-act="clear-outfit">Clear</button></div>
       <div class="small muted">These products will be generated together in one image.${outfitOther.length ? ` Includes ${outfitOther.length} item(s) from other pages.` : ''}</div>
       <div class="result-products">${state.outfit.map((id) => {
         const p = state.known[id];
         return p ? `<img src="${esc(state.sel[id].images[0] || p.images[0]?.url)}" title="${esc(p.title)}" alt="" />` : '';
       }).join('')}</div></div>`
    : '';

  let list = '';
  if (!state.scanning && page && !state.products.length) {
    list = `<div class="empty"><div class="big">🔍</div><p>No products detected on this page.</p>
      <p class="small">Tip: open a product page, or right-click any product image and choose <b>“Try this on with TryOn AI”</b>.</p></div>`;
  } else {
    list = `<div class="product-list">${state.products.map(productHtml).join('')}</div>`;
  }

  return `${profileGateHtml()}${jobBannerHtml()}${head}${outfitHtml}${list}${state.products.length ? sceneHtml() : ''}`;
}

function productHtml(p) {
  const sel = state.sel[p.id] || ensureSel(p);
  const selected = p.id === state.selectedId;
  const inOutfit = state.outfit.includes(p.id);
  const thumb = sel.images[0] || p.images[0]?.url;
  return `<div class="product ${selected ? 'selected' : ''} ${inOutfit ? 'in-outfit' : ''}" data-pid="${esc(p.id)}">
    <div class="product-main" data-act="select" data-pid="${esc(p.id)}">
      <img class="product-thumb" src="${esc(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
      <div class="grow">
        <div class="product-title" title="${esc(p.title)}">${esc(p.title)}</div>
        <div class="product-meta">
          ${p.price ? `<span class="price">${esc(p.price)}</span>` : ''}
          ${p.brand ? `<span class="chip">${esc(p.brand)}</span>` : ''}
          <span class="chip accent">${esc(catLabel(sel.category))}</span>
          ${p.isPrimary ? '<span class="chip ok">Viewing</span>' : ''}
        </div>
        <div class="product-meta">
          <span class="small muted">${esc(sourceLabel(p.source))} · ${p.images.length} image${p.images.length === 1 ? '' : 's'}</span>
          <label class="outfit-toggle" data-stop="1"><input type="checkbox" data-act="toggle-outfit" data-pid="${esc(p.id)}" ${inOutfit ? 'checked' : ''}/> Outfit</label>
        </div>
      </div>
    </div>
    ${selected ? productDetailHtml(p, sel) : ''}
  </div>`;
}

function productDetailHtml(p, sel) {
  const cats = Object.entries(state.config?.categories || {});
  const imgs = (sel.variant?.images?.length ? sel.variant.images : p.images).slice(0, 12);
  const profile = activeProfile();
  let photoHint = '';
  if (profile && state.config) {
    const wanted = state.config.categories[sel.category]?.photos || [];
    const have = profile.photos.map((ph) => ph.slot);
    if (wanted.length && !wanted.some((s) => have.includes(s))) {
      photoHint = `<div class="callout warn small">For ${esc(catLabel(sel.category))}, add a <b>${esc(slotLabel(wanted[0]))}</b> photo to your profile for accurate results. <button class="btn ghost sm" data-act="goto" data-view="profile">Add</button></div>`;
    } else if (wanted[0] && !have.includes(wanted[0])) {
      photoHint = `<div class="small muted">Tip: a <b>${esc(slotLabel(wanted[0]))}</b> photo improves ${esc(catLabel(sel.category))} try-ons.</div>`;
    }
  }
  return `<div class="product-detail">
    <div class="label">Category ${sel.category === sel.autoCategory && sel.confidence < 0.5 ? '<span class="chip warn">please check</span>' : ''}</div>
    <select class="input" data-act="category" data-pid="${esc(p.id)}">
      ${cats.map(([k, c]) => `<option value="${esc(k)}" ${k === sel.category ? 'selected' : ''}>${esc(c.label)}${k === sel.autoCategory ? ' (detected)' : ''}</option>`).join('')}
    </select>
    ${p.variants?.length ? `<div class="label">Variant</div><div class="variant-list">
      ${p.variants.map((v, i) => `<button class="variant ${sel.variant?.name === v.name ? 'on' : ''}" data-act="variant" data-pid="${esc(p.id)}" data-idx="${i}">${esc(v.name)}</button>`).join('')}</div>` : ''}
    <div class="label">Product image${imgs.length > 1 ? 's <span class="small muted" style="text-transform:none;font-weight:400">(tap to choose, up to 3 - #1 is the main one)</span>' : ''}</div>
    <div class="image-strip">
      ${imgs.map((img) => {
        const idx = sel.images.indexOf(img.url);
        return `<button class="image-opt ${idx >= 0 ? 'on' : ''}" data-act="pick-image" data-pid="${esc(p.id)}" data-url="${esc(img.url)}" title="${esc(img.alt || '')}">
          <img src="${esc(img.url)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
          ${idx >= 0 ? `<span class="badge">${idx + 1}</span>` : ''}
          ${img.url === sel.bestUrl && imgs.length > 1 ? '<span class="best">BEST</span>' : ''}
        </button>`;
      }).join('')}
    </div>
    ${sel.bestUrl && imgs.length > 1 && sel.analyzed ? `<div class="small muted">Auto-picked the clearest${sel.bestPlain ? ' product-only shot on a plain background' : ' product image'}.</div>` : ''}
    ${photoHint}
  </div>`;
}

function sceneHtml() {
  const scenes = Object.entries(state.config?.scenes || {}).filter(([k]) => k !== 'studio');
  const m = state.scene.mode;
  return `<div class="card">
    <div class="label" style="margin-top:0">Scene & style</div>
    <select class="input" data-act="scene">
      <option value="auto" ${m === 'auto' ? 'selected' : ''}>✨ Auto - match the product (e.g. beach for swimwear)</option>
      <option value="studio" ${m === 'studio' ? 'selected' : ''}>Studio (plain background)</option>
      <option value="original" ${m === 'original' ? 'selected' : ''}>Keep my photo's background</option>
      ${scenes.map(([k, s]) => `<option value="${esc(k)}" ${m === k ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
      <option value="custom" ${m === 'custom' ? 'selected' : ''}>Custom…</option>
    </select>
    ${m === 'custom' ? `<input class="input" style="margin-top:6px" data-act="scene-text" maxlength="300" placeholder="e.g. walking through a Paris street at sunset" value="${esc(state.scene.text)}" />` : ''}
    <label class="switch small" style="margin-top:8px"><input type="checkbox" data-act="fast" ${state.fast ? 'checked' : ''}/> ⚡ Fast mode (lower latency)</label>
  </div>`;
}

const TIPS = [
  'Your product image and profile photos are sent securely to the AI.',
  'Tip: tick "Outfit" on several products to try them together.',
  'Results are saved in your Wardrobe so you can compare them later.',
  'Tip: a plain, well-lit full-body photo gives the most realistic results.',
];

function progressParts() {
  const j = state.job || {};
  const elapsed = Math.round((Date.now() - (j.startedAt || Date.now())) / 1000);
  const pct = Math.min(100, j.progress || 5);
  const eta = j.etaMs ? ` · about ${Math.max(1, Math.round(j.etaMs / 1000))}s left` : '';
  return {
    stage: j.stageLabel || 'Working…',
    pct,
    meta: `${pct}% · ${elapsed}s elapsed${eta}${j.queuePosition ? ` · position ${j.queuePosition} in queue` : ''}`,
    tip: TIPS[Math.floor(elapsed / 6) % TIPS.length],
  };
}

function progressHtml() {
  const j = state.job || {};
  if (j.status === 'failed') {
    return `<div class="callout err"><h3>Try-on failed</h3><p>${esc(j.error?.message || 'Unknown error')}</p>
      <div class="btn-row">${j.error?.retryable !== false ? '<button class="btn primary sm" data-act="retry">Try again</button>' : ''}
      <button class="btn sm" data-act="back">Back to products</button></div></div>`;
  }
  const p = progressParts();
  return `<div class="card progress-wrap">
    <div class="progress-visual">${j.previewUrl ? `<img src="${esc(j.previewUrl)}" alt="" referrerpolicy="no-referrer"/>` : ''}</div>
    <div class="stage" id="pgStage">${esc(p.stage)}</div>
    <div class="bar"><div id="pgBar" style="width:${p.pct}%"></div></div>
    <div class="small muted" id="pgMeta">${esc(p.meta)}</div>
    <p class="small muted" style="margin-top:12px" id="pgTip">${esc(p.tip)}</p>
    <button class="btn sm" data-act="background">Keep browsing - notify me when ready</button>
  </div>`;
}

function resultHtml() {
  const j = state.job;
  if (!j || j.status !== 'done') return progressHtml();
  const items = j.items || [];
  return `<div class="card">
    <img class="result-img" data-auth-src="/results/${esc(j.id)}/image" alt="Your virtual try-on" />
    <div class="product-meta" style="margin-top:8px">
      ${j.cached ? '<span class="chip ok">Instant (cached)</span>' : ''}
      ${j.scene && !String(j.model).startsWith('hf:') ? `<span class="chip accent">${esc(j.scene.label)}</span>` : ''}
      ${j.durationMs && !j.cached ? `<span class="chip">${fmtMs(j.durationMs)}</span>` : ''}
      ${j.provider === 'mock' ? '<span class="chip warn">Demo mode</span>'
        : String(j.model).startsWith('hf:') ? '<span class="chip">Free model (IDM-VTON)</span>'
        : `<span class="chip">${esc(j.model || '')}</span>`}
    </div>
    <div class="label">Products</div>
    ${items.map((it) => `<div class="row" style="margin-bottom:6px">
        <img data-auth-src="/product-images/${esc(it.imageIds[0])}" alt="" style="width:40px;height:50px;border-radius:6px;object-fit:cover;border:1px solid var(--line)" />
        <div class="grow"><div class="product-title small">${esc(it.title)}</div><span class="chip accent">${esc(catLabel(it.category))}</span>
        ${it.pageUrl ? ` <a class="small" href="${esc(it.pageUrl)}" target="_blank" rel="noopener">View product</a>` : ''}</div></div>`).join('')}
    <div class="btn-row">
      <button class="btn sm primary" data-act="download">⬇ Download</button>
      <button class="btn sm" data-act="regenerate">↻ Regenerate</button>
      <button class="btn sm" data-act="compare-add">⇆ Compare</button>
      <button class="btn sm danger" data-act="delete-result">Delete</button>
    </div>
    <button class="btn block" style="margin-top:10px" data-act="back">← Try another product</button>
  </div>`;
}

function renderActionBar() {
  const bar = $('#actionBar');
  const show = state.view === 'tryon' && state.online && !state.jobView && state.products.length > 0;
  bar.classList.toggle('hidden', !show);
  if (!show) return;
  const profile = activeProfile();
  const count = state.outfit.length;
  const hasPhotos = profile?.photos.length > 0;
  const busy = state.job && !['done', 'failed'].includes(state.job.status);
  let hint = '';
  if (!hasPhotos) hint = 'Add a photo to your profile to enable Try On';
  else if (busy) hint = 'A try-on is already in progress';
  else if (count) hint = `${count} product${count > 1 ? 's' : ''} selected as an outfit`;
  else if (state.selectedId) hint = `Trying on as ${profile.name}`;
  bar.innerHTML = `${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
    <button class="btn primary block" data-act="tryon" ${!hasPhotos || busy || (!count && !state.selectedId) ? 'disabled' : ''}>
      ✨ ${count > 1 ? `Try On Outfit (${count})` : 'Try On'}</button>`;
}

// ---------------------------------------------------------------- rendering: Profile

function renderProfile() {
  const root = $('#view-profile');
  if (state.online === false) {
    root.innerHTML = offlineCard();
    return;
  }
  if (!state.config) return;
  const profile = activeProfile();
  if (!profile) {
    root.innerHTML = `<div class="card stack">
      <h2>Create your digital profile</h2>
      <p class="muted">Your profile is a set of photos of you that the AI uses for every try-on. You only do this once.</p>
      <ol class="small muted" style="padding-left:18px;line-height:1.6">
        <li>Create a profile and give it a name.</li>
        <li>Upload a full-body photo (required) and optional close-ups.</li>
        <li>Browse any shopping site and press <b>Try On</b>.</li>
      </ol>
      <label class="field"><span>Profile name</span><input id="newProfileName" class="input" maxlength="60" placeholder="e.g. Me" /></label>
      <button class="btn primary block" data-act="create-profile">Create profile</button>
      <p class="small muted">🔒 Photos are stored privately on your TryOn AI server, never public, never used for AI training. You can delete them at any time.</p>
    </div>`;
    return;
  }

  const slots = Object.entries(state.config.photoSlots);
  const have = profile.photos.map((p) => p.slot);
  const coverage = Object.entries(state.config.categories).map(([k, c]) => {
    const ok = c.photos.some((s) => have.includes(s));
    const best = have.includes(c.photos[0]);
    return `<span class="chip ${best ? 'ok' : ok ? '' : 'warn'}" title="${esc(best ? 'Best photo available' : ok ? `Better with a ${slotLabel(c.photos[0])} photo` : `Needs a ${slotLabel(c.photos[0])} photo`)}">${best ? '✓' : ok ? '~' : '!'} ${esc(c.label)}</span>`;
  }).join('');

  root.innerHTML = `
    <div class="card">
      <div class="row between"><h2>${esc(profile.name)}</h2>
        <button class="btn sm danger" data-act="delete-profile">Delete profile</button></div>
      <p class="small muted">Add photos for the product types you want to try. The full-body photo is the minimum.</p>
      <div class="slot-grid">${slots.map(([slot, def]) => slotHtml(profile, slot, def)).join('')}</div>
    </div>
    <div class="card">
      <h3>Supported categories with your photos</h3>
      <div class="coverage">${coverage}</div>
    </div>
    <div class="card">
      <h3>Details (optional)</h3>
      <p class="small muted">Helps the AI get fit and proportions right.</p>
      <label class="field"><span>Name</span><input class="input" id="pfName" maxlength="60" value="${esc(profile.name)}" /></label>
      <div class="row">
        <label class="field grow"><span>Height (cm)</span><input class="input" id="pfHeight" type="number" min="50" max="250" value="${esc(profile.heightCm || '')}" /></label>
        <label class="field grow"><span>Preferred fit</span><select class="input" id="pfFit">
          ${['', 'regular', 'slim', 'relaxed', 'oversized'].map((f) => `<option value="${f}" ${profile.fitPreference === f ? 'selected' : ''}>${f || '-'}</option>`).join('')}
        </select></label>
      </div>
      <label class="field"><span>Notes for the AI</span><textarea class="input" id="pfNotes" maxlength="200" placeholder="e.g. I usually tuck in shirts">${esc(profile.notes)}</textarea></label>
      <button class="btn primary sm" data-act="save-profile">Save details</button>
    </div>
    <p class="small muted" style="padding:0 4px">🔒 Photos are resized, stripped of location/EXIF data and stored privately on your TryOn AI server (${esc(state.config.privacy?.storage || '')}). ${esc(state.config.privacy?.training || '')}</p>`;
  hydrateAuthImages(root);
}

function slotHtml(profile, slot, def) {
  const photo = profile.photos.find((p) => p.slot === slot);
  const busy = state.uploading[slot];
  const path = photoPath(profile, slot);
  return `<div class="slot ${photo ? 'filled' : ''}" data-slot="${esc(slot)}">
    <div class="slot-title"><span>${esc(def.label)}</span>${def.required ? '<span class="chip accent">Required</span>' : '<span class="chip">Optional</span>'}</div>
    ${photo ? `<img class="slot-preview" data-auth-src="${esc(path)}" alt="${esc(def.label)}" />`
      : `<div class="slot-preview">${busy ? '<span class="spinner"></span>' : '📷'}</div>`}
    <div class="small muted">${esc(def.description)}</div>
    ${(photo?.warnings || []).map((w) => `<div class="warn-text">⚠ ${esc(w)}</div>`).join('')}
    <details><summary>How to take this photo</summary><ul>${def.guidance.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></details>
    <div class="row">
      <button class="btn sm ${photo ? '' : 'primary'} grow" data-act="upload" data-slot="${esc(slot)}" ${busy ? 'disabled' : ''}>${busy ? 'Uploading…' : photo ? 'Replace' : 'Upload'}</button>
      ${photo ? `<button class="btn sm danger" data-act="remove-photo" data-slot="${esc(slot)}" title="Remove">✕</button>` : ''}
    </div>
  </div>`;
}

async function uploadPhoto(slot, file) {
  const profile = activeProfile();
  if (!profile || !file) return;
  state.uploading[slot] = true;
  renderProfile();
  try {
    const { blob, hints } = await prepareProfilePhoto(file);
    const fd = new FormData();
    fd.append('photo', blob, `${slot}.jpg`);
    const updated = await api(`/profiles/${profile.id}/photos/${slot}`, { method: 'PUT', form: fd });
    forgetImage(`/profiles/${profile.id}/photos/${slot}`);
    Object.assign(profile, updated);
    toast(hints.length ? `Saved. ${hints[0]}` : `${slotLabel(slot)} photo saved`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    state.uploading[slot] = false;
    renderProfile();
    renderActionBar();
  }
}

// ---------------------------------------------------------------- rendering: Wardrobe

async function renderWardrobe(reload = false) {
  const root = $('#view-wardrobe');
  if (state.online === false) {
    root.innerHTML = offlineCard();
    return;
  }
  if (reload || !state.results.length) {
    root.innerHTML = '<div class="card row"><span class="spinner"></span> Loading your wardrobe…</div>';
    try {
      state.results = (await api(`/results${state.activeProfileId ? `?profileId=${encodeURIComponent(state.activeProfileId)}` : ''}`)).results;
    } catch (err) {
      root.innerHTML = `<div class="callout err">${esc(err.message)}</div>`;
      return;
    }
  }
  if (!state.results.length) {
    root.innerHTML = '<div class="empty"><div class="big">👚</div><p>No try-ons yet.</p><p class="small">Your generated looks will be saved here.</p></div>';
    return;
  }
  root.innerHTML = `<div class="card row between">
      <div><h3 style="margin:0">Virtual wardrobe</h3><div class="small muted">${state.results.length} look${state.results.length === 1 ? '' : 's'} · tick two to compare</div></div>
      <div class="row"><button class="btn sm primary" data-act="compare" ${state.compare.length === 2 ? '' : 'disabled'}>Compare (${state.compare.length}/2)</button></div>
    </div>
    <div class="wardrobe-grid">${state.results.map((r) => `
      <div class="w-item ${state.compare.includes(r.id) ? 'cmp' : ''}" data-act="open-result" data-rid="${esc(r.id)}">
        <img data-auth-src="/results/${esc(r.id)}/image?size=thumb" alt="" />
        <input type="checkbox" class="cmp-box" data-act="toggle-compare" data-rid="${esc(r.id)}" ${state.compare.includes(r.id) ? 'checked' : ''} title="Compare" />
        <div class="cap">${esc(r.items.map((i) => i.title).join(' + '))}</div>
      </div>`).join('')}</div>
    <button class="btn sm danger" style="margin-top:12px" data-act="delete-all-results">Delete all results</button>`;
  hydrateAuthImages(root);
}

function showCompare() {
  const [a, b] = state.compare.map((id) => state.results.find((r) => r.id === id)).filter(Boolean);
  if (!a || !b) return;
  const col = (r) => `<div><img data-auth-src="/results/${esc(r.id)}/image" alt="" />
    <div class="small" style="margin-top:4px">${esc(r.items.map((i) => i.title).join(' + '))}</div>
    <div class="small muted">${esc(r.items.map((i) => i.price).filter(Boolean).join(' + '))}</div></div>`;
  openModal(`<div class="row between" style="margin-bottom:8px"><h3 style="margin:0">Side-by-side</h3><button class="btn sm" data-act="close-modal">Close</button></div>
    <div class="compare">${col(a)}${col(b)}</div>`);
}

function openModal(html) {
  const m = $('#modal');
  m.innerHTML = `<div class="modal-body">${html}</div>`;
  m.classList.remove('hidden');
  hydrateAuthImages(m);
}

// ---------------------------------------------------------------- rendering: Settings

async function renderSettings() {
  const root = $('#view-settings');
  const s = await getSettings();
  let me = null;
  if (state.online) me = await api('/me').catch(() => null);
  state.me = me;
  root.innerHTML = `
    <div class="card">
      <h3>Server</h3>
      <p class="small muted">The TryOn AI backend stores your profile and talks to the AI provider. AI API keys live only on the server - never in this extension.</p>
      <label class="field"><span>Backend URL</span><input class="input" id="backendUrl" value="${esc(s.backendUrl)}" placeholder="https://your-project.vercel.app" /></label>
      <p class="small muted">Defaults to the hosted server. Use http://127.0.0.1:8787 for local development.</p>
      <div class="row"><button class="btn sm primary" data-act="save-server">Save & connect</button>
      <span class="small ${state.online ? '' : 'muted'}">${state.online ? `✅ Connected · AI: <b>${esc(state.config.provider)}</b> (${esc(state.config.model)})` : `❌ ${esc(state.connError || 'Not connected')}`}</span></div>
      ${state.online && state.config.provider === 'mock' ? '<p class="small" style="color:var(--warn);margin-top:8px">The server is in demo mode (no AI key configured). Results are labelled composites, not AI generations.</p>' : ''}
    </div>
    <div class="card">
      <h3>Performance</h3>
      <label class="switch"><input type="checkbox" data-act="fast" ${state.fast ? 'checked' : ''}/> ⚡ Fast mode - lower latency, slightly less detail</label>
    </div>
    <div class="card">
      <h3>Privacy</h3>
      <p class="small">📍 <b>Where your photos are stored:</b> on the TryOn AI server at <code>${esc(s.backendUrl)}</code>, in a private folder only accessible with this browser's device token. They are never public.</p>
      <p class="small">🤖 <b>AI processing:</b> photos are sent over an encrypted connection to the AI provider only to generate your try-on.</p>
      <label class="switch small"><input type="checkbox" data-act="consent" ${me?.consentTraining ? 'checked' : ''} ${me ? '' : 'disabled'}/> Allow my images to be used to improve the service (off by default)</label>
      ${me ? `<p class="small muted" style="margin-top:8px">Stored: ${me.counts.profiles} profile(s), ${me.counts.photos} photo(s), ${me.counts.results} result(s).</p>` : ''}
      <button class="btn sm danger" data-act="delete-everything" ${me ? '' : 'disabled'}>Delete all my data</button>
    </div>
    <p class="small muted" style="text-align:center">TryOn AI v${esc(chrome.runtime.getManifest().version)}</p>`;
}

// ---------------------------------------------------------------- navigation & events

function switchView(view) {
  state.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  $('#modal').classList.add('hidden');
  if (view === 'tryon') renderTryOn();
  if (view === 'profile') renderProfile();
  if (view === 'wardrobe') renderWardrobe(true);
  if (view === 'settings') renderSettings();
  renderActionBar();
  window.scrollTo(0, 0);
}

async function onAction(act, el, ev) {
  const pid = el.dataset.pid;
  switch (act) {
    case 'goto': return switchView(el.dataset.view);
    case 'reconnect': await connect(); return render();
    case 'rescan': return scan();
    case 'select':
      if (ev.target.closest('[data-stop]')) return;
      return selectProduct(pid);
    case 'toggle-outfit': {
      if (el.checked) {
        if (state.outfit.length >= 4) {
          el.checked = false;
          return toast('An outfit can have up to 4 products', true);
        }
        state.outfit.push(pid);
        prefetchImage(state.known[pid], state.sel[pid].images[0] || state.known[pid].images[0].url);
      } else {
        state.outfit = state.outfit.filter((x) => x !== pid);
      }
      return renderTryOn();
    }
    case 'clear-outfit': state.outfit = []; return renderTryOn();
    case 'pick-image': {
      const sel = state.sel[pid];
      const url = el.dataset.url;
      sel.touched = true;
      if (sel.images.includes(url)) {
        if (sel.images.length > 1) sel.images = sel.images.filter((u) => u !== url);
      } else if (sel.images.length >= 3) {
        sel.images = [...sel.images.slice(0, 2), url];
      } else {
        sel.images.push(url);
      }
      prefetchImage(state.known[pid], url);
      return renderTryOn();
    }
    case 'variant': {
      const p = state.known[pid];
      const sel = state.sel[pid];
      const v = p.variants[Number(el.dataset.idx)];
      sel.variant = sel.variant?.name === v.name ? null : v;
      if (sel.variant?.images?.length) {
        sel.images = [sel.variant.images[0].url];
        sel.touched = true;
        prefetchImage(p, sel.images[0]);
      }
      return renderTryOn();
    }
    case 'tryon': return startTryOn();
    case 'retry': return startTryOn({ body: state.lastBody });
    case 'regenerate': return startTryOn({ force: true, body: state.lastBody });
    case 'back': state.jobView = null; return renderTryOn();
    case 'background': state.jobView = null; return renderTryOn();
    case 'show-progress': state.jobView = 'progress'; return renderTryOn();
    case 'show-result': state.jobView = 'result'; return renderTryOn();
    case 'download': {
      const url = await authImage(`/results/${state.job.id}/image`);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tryon-${state.job.id}.png`;
      a.click();
      return;
    }
    case 'compare-add': {
      if (!state.compare.includes(state.job.id)) state.compare = [...state.compare.slice(-1), state.job.id];
      toast('Added to comparison - pick another look in Wardrobe');
      return switchView('wardrobe');
    }
    case 'delete-result':
      if (!confirm('Delete this result?')) return;
      await deleteResult(state.job.id);
      state.job = null;
      state.jobView = null;
      return renderTryOn();
    case 'open-result': {
      if (ev.target.closest('.cmp-box')) return;
      const r = state.results.find((x) => x.id === el.dataset.rid);
      return r && openResult(r);
    }
    case 'toggle-compare': {
      const id = el.dataset.rid;
      state.compare = state.compare.includes(id) ? state.compare.filter((x) => x !== id) : [...state.compare.slice(-1), id];
      return renderWardrobe();
    }
    case 'compare': return showCompare();
    case 'close-modal': return $('#modal').classList.add('hidden');
    case 'delete-all-results':
      if (!confirm('Delete ALL saved try-on results?')) return;
      await api('/results', { method: 'DELETE' });
      forgetImage('/results/');
      state.results = [];
      state.compare = [];
      toast('All results deleted');
      return renderWardrobe(true);
    case 'create-profile':
      try {
        await createProfile($('#newProfileName')?.value.trim());
        toast('Profile created - now add your photos');
      } catch (err) { toast(err.message, true); }
      return renderProfile();
    case 'save-profile': {
      const profile = activeProfile();
      try {
        const updated = await api(`/profiles/${profile.id}`, {
          method: 'PATCH',
          body: { name: $('#pfName').value, heightCm: $('#pfHeight').value || null, fitPreference: $('#pfFit').value, notes: $('#pfNotes').value },
        });
        Object.assign(profile, updated);
        renderSwitcher();
        toast('Profile saved');
      } catch (err) { toast(err.message, true); }
      return renderProfile();
    }
    case 'delete-profile': {
      const profile = activeProfile();
      if (!confirm(`Delete profile "${profile.name}", all its photos and its try-on results? This cannot be undone.`)) return;
      await api(`/profiles/${profile.id}`, { method: 'DELETE' });
      forgetImage(`/profiles/${profile.id}`);
      await loadProfiles();
      toast('Profile deleted');
      return render();
    }
    case 'upload': {
      const input = $('#fileInput');
      input.dataset.slot = el.dataset.slot;
      input.value = '';
      return input.click();
    }
    case 'remove-photo': {
      const profile = activeProfile();
      const updated = await api(`/profiles/${profile.id}/photos/${el.dataset.slot}`, { method: 'DELETE' });
      forgetImage(`/profiles/${profile.id}/photos/${el.dataset.slot}`);
      Object.assign(profile, updated);
      renderActionBar();
      return renderProfile();
    }
    case 'save-server': {
      const url = $('#backendUrl').value.trim().replace(/\/+$/, '') || DEFAULT_BACKEND;
      const prev = (await getSettings()).backendUrl;
      await saveSettings({ backendUrl: url });
      if (url !== prev) await chrome.storage.local.remove('token');
      await connect();
      toast(state.online ? 'Connected' : state.connError, !state.online);
      render();
      return renderSettings();
    }
    case 'consent':
      await api('/me', { method: 'PATCH', body: { consentTraining: el.checked } });
      return toast(el.checked ? 'Thanks - preference saved' : 'Your images will not be used for improvement');
    case 'delete-everything':
      if (!confirm('Permanently delete ALL your profiles, photos and results from the server?')) return;
      await api('/me', { method: 'DELETE' });
      await chrome.storage.local.remove('token');
      await chrome.storage.session.remove('jobId');
      forgetImage('/');
      Object.assign(state, { profiles: [], activeProfileId: null, results: [], compare: [], job: null, jobView: null, outfit: [] });
      prepared.clear();
      toast('All your data has been deleted');
      await connect();
      return switchView('profile');
    default:
  }
}

function bindEvents() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type !== 'checkbox')) return;
    if (el.tagName === 'INPUT' && el.type === 'checkbox' && ['toggle-outfit', 'toggle-compare', 'fast', 'consent'].includes(el.dataset.act)) return;
    onAction(el.dataset.act, el, ev).catch((err) => toast(err.message, true));
  });

  document.addEventListener('change', (ev) => {
    const el = ev.target;
    const act = el.dataset?.act;
    if (act === 'category') {
      state.sel[el.dataset.pid].category = el.value;
      renderTryOn();
    } else if (act === 'scene') {
      state.scene.mode = el.value;
      renderTryOn();
    } else if (act === 'fast') {
      state.fast = el.checked;
      saveSettings({ fastMode: state.fast });
    } else if (['toggle-outfit', 'toggle-compare', 'consent'].includes(act)) {
      onAction(act, el, ev).catch((err) => toast(err.message, true));
    }
  });

  document.addEventListener('input', (ev) => {
    if (ev.target.dataset?.act === 'scene-text') state.scene.text = ev.target.value;
  });

  $('#profileSwitcher').addEventListener('change', async (ev) => {
    if (ev.target.value === '__new') {
      const name = prompt('Name for the new profile:', `Profile ${state.profiles.length + 1}`);
      if (name === null) return renderSwitcher();
      try {
        await createProfile(name);
        switchView('profile');
      } catch (err) {
        toast(err.message, true);
        renderSwitcher();
      }
      return;
    }
    state.results = [];
    await setActiveProfile(ev.target.value);
  });

  $('#fileInput').addEventListener('change', (ev) => {
    const file = ev.target.files?.[0];
    if (file) uploadPhoto(ev.target.dataset.slot, file);
  });

  const profileView = $('#view-profile');
  profileView.addEventListener('dragover', (ev) => {
    const slot = ev.target.closest('.slot');
    if (!slot) return;
    ev.preventDefault();
    slot.classList.add('dragover');
  });
  profileView.addEventListener('dragleave', (ev) => ev.target.closest('.slot')?.classList.remove('dragover'));
  profileView.addEventListener('drop', (ev) => {
    const slot = ev.target.closest('.slot');
    if (!slot) return;
    ev.preventDefault();
    slot.classList.remove('dragover');
    const file = ev.dataTransfer.files?.[0];
    if (file) uploadPhoto(slot.dataset.slot, file);
  });

  $('#modal').addEventListener('click', (ev) => {
    if (ev.target.id === 'modal') ev.currentTarget.classList.add('hidden');
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'tab-changed') scheduleScan();
    if (msg?.type === 'pending-image') checkPendingImage();
  });
}

async function init() {
  bindEvents();
  state.fast = (await getSettings()).fastMode;
  await connect();
  if (state.online && !state.profiles.length) switchView('profile');
  else render();
  await resumeJob();
  await scan();
  await checkPendingImage();
}

init();
