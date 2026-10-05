/*
 * TryOn AI product detector. Injected on demand (chrome.scripting) into the active tab.
 * It never modifies the page except for a temporary highlight overlay and
 * data-tryon-id attributes used to scroll to a detected product.
 *
 * Signals used, strongest first:
 *   1. schema.org JSON-LD (Product, ProductGroup + hasVariant, ItemList, BreadcrumbList)
 *   2. schema.org microdata (itemtype=Product)
 *   3. Open Graph / product meta tags (og:image, product:price:amount, ...)
 *   4. DOM heuristics: main gallery around the largest product image + H1 + price
 *   5. Listing heuristics: repeated "cards" containing image + link + price
 */
(() => {
  const VERSION = 4;
  if (globalThis.__tryOnAI?.version === VERSION) return;

  const MAX_PRODUCTS = 40;
  const BAD_URL = /(logo|icon|sprite|favicon|banner|badge|payment|flag|avatar|placeholder|loading|spinner|pixel|tracking|1x1|blank\.|transparent|swatch|rating|stars?[-_.]|emoji|qr[-_]?code|social|facebook|instagram|twitter|youtube|whatsapp|pinterest)/i;
  const PRICE_RE = /(?:[$€£¥₹₩₺₽]|\b(?:rs\.?|inr|usd|eur|gbp|aed|sar|cad|aud|chf|sek|nok|dkk|pln|jpy|kr)\b)\s?\d[\d,.\s]{0,12}\d|\d[\d,.]{0,12}\s?(?:[$€£¥₹]|\b(?:usd|eur|gbp|inr|aed|sek|nok|dkk|pln|kr|zł)\b)/i;
  const ADD_TO_CART = /add to (cart|bag|basket|trolley)|buy now|add to wishlist|in den warenkorb|ajouter au panier|añadir a la cesta/i;

  const clean = (s, max = 300) => {
    if (!s || typeof s !== 'string') return '';
    const t = s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  const abs = (u) => {
    if (!u || typeof u !== 'string' || u.startsWith('data:') || u.startsWith('blob:')) return null;
    try {
      const url = new URL(u.trim(), location.href);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  };
  const meta = (name) =>
    document.querySelector(`meta[property="${name}"], meta[name="${name}"], meta[itemprop="${name}"]`)?.getAttribute('content') || '';
  const metaAll = (name) =>
    [...document.querySelectorAll(`meta[property="${name}"], meta[name="${name}"]`)].map((m) => m.getAttribute('content')).filter(Boolean);

  // ---------- image URL helpers ----------

  function largestFromSrcset(srcset) {
    if (!srcset) return null;
    let best = null;
    let bestW = -1;
    for (const part of srcset.split(/,\s+(?=\S)/)) {
      const [url, desc = '1x'] = part.trim().split(/\s+/);
      const n = parseFloat(desc) * (desc.endsWith('x') ? 1000 : 1);
      if (url && n > bestW) {
        best = url;
        bestW = n;
      }
    }
    return best;
  }

  /** Request a larger rendition from common CDNs (Shopify, Amazon, Cloudinary-style, width params). */
  function upgradeUrl(url) {
    try {
      const u = new URL(url);
      if (/amazon|media-amazon|ssl-images-amazon/.test(u.hostname)) {
        u.pathname = u.pathname.replace(/\._[^/]*_\.(jpe?g|png|webp)$/i, '._AC_SL1200_.$1');
        return u.href;
      }
      if (/shopify|\/cdn\/shop\//.test(u.hostname + u.pathname)) {
        u.pathname = u.pathname.replace(/_(\d+x\d*|\d*x\d+|pico|icon|thumb|small|compact|medium|large|grande)(@\dx)?(?=\.\w+$)/i, '');
      }
      u.pathname = u.pathname.replace(/([,/])w_(\d+)(?=[,/])/, (m, sep, w) => (Number(w) < 1000 ? `${sep}w_1200` : m))
        .replace(/([,/])h_(\d+)(?=[,/])/, (m, sep, h) => (Number(h) < 1400 ? `${sep}h_1600` : m));
      const wKey = ['w', 'width', 'wid', 'imwidth', 'sw', 'imgw'].find((k) => u.searchParams.has(k));
      if (wKey) {
        const w = Number(u.searchParams.get(wKey));
        if (w && w < 1000) {
          const f = 1200 / w;
          u.searchParams.set(wKey, '1200');
          const hKey = ['h', 'height', 'hei', 'sh', 'imgh'].find((k) => u.searchParams.has(k));
          if (hKey && Number(u.searchParams.get(hKey))) u.searchParams.set(hKey, String(Math.round(Number(u.searchParams.get(hKey)) * f)));
        }
      }
      return u.href;
    } catch {
      return url;
    }
  }

  function imgSources(img) {
    const attrs = ['data-zoom-image', 'data-zoom', 'data-large-image', 'data-large', 'data-old-hires', 'data-full', 'data-hires', 'data-src-large', 'data-original', 'data-lazy-src', 'data-src'];
    const hi = attrs.map((a) => img.getAttribute(a)).find((v) => v && !v.startsWith('data:'));
    let dyn = null;
    const dynAttr = img.getAttribute('data-a-dynamic-image');
    if (dynAttr) {
      try {
        const entries = Object.entries(JSON.parse(dynAttr));
        entries.sort((a, b) => b[1][0] * b[1][1] - a[1][0] * a[1][1]);
        dyn = entries[0]?.[0];
      } catch { /* ignore */ }
    }
    const pictureSrc = img.parentElement?.tagName === 'PICTURE'
      ? largestFromSrcset([...img.parentElement.querySelectorAll('source')].map((s) => s.getAttribute('srcset') || s.getAttribute('data-srcset')).find(Boolean))
      : null;
    const fromSet = largestFromSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset'));
    const best = abs(dyn || hi || fromSet || pictureSrc || img.currentSrc || img.src);
    const fallback = abs(img.currentSrc || img.src);
    return { best, fallback };
  }

  function imageEntry(url, extra = {}) {
    const a = abs(url);
    if (!a || BAD_URL.test(a) || /\.svg(\?|$)/i.test(a)) return null;
    const up = upgradeUrl(a);
    return { url: up, fallbackUrl: up !== a ? a : null, ...extra };
  }

  const keyOf = (url) => {
    try {
      const u = new URL(url);
      return (u.hostname + u.pathname).toLowerCase()
        .replace(/\._[^/]*_\.(jpe?g|png|webp)$/, '')
        .replace(/_(\d+x\d*|\d*x\d+)(?=\.\w+$)/, '')
        .replace(/[,/][wh]_\d+/g, '');
    } catch {
      return url;
    }
  };

  function pushImage(list, entry) {
    if (!entry) return;
    const k = keyOf(entry.url);
    const existing = list.find((e) => keyOf(e.url) === k);
    if (existing) {
      existing.score = Math.max(existing.score || 0, entry.score || 0);
      existing.width = existing.width || entry.width;
      existing.height = existing.height || entry.height;
      existing.alt = existing.alt || entry.alt;
      return;
    }
    list.push(entry);
  }

  function ldImages(img) {
    const out = [];
    const walk = (v) => {
      if (!v) return;
      if (typeof v === 'string') out.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === 'object') walk(v.contentUrl || v.url || v.thumbnailUrl);
    };
    walk(img);
    return out;
  }

  // ---------- 1. JSON-LD ----------

  function parseJsonLd() {
    const products = [];
    const listItems = [];
    let breadcrumbs = [];
    const types = (n) => [].concat(n?.['@type'] || []).map(String);
    const walk = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || depth > 8) return;
      if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
      const t = types(node);
      if (t.some((x) => /^(Product|ProductGroup|IndividualProduct|ProductModel|Vehicle)$/.test(x))) products.push(node);
      if (t.includes('BreadcrumbList')) {
        breadcrumbs = [].concat(node.itemListElement || [])
          .sort((a, b) => (a.position || 0) - (b.position || 0))
          .map((li) => clean(li.name || li.item?.name || '', 60))
          .filter(Boolean);
      }
      if (t.includes('ItemList')) {
        for (const li of [].concat(node.itemListElement || [])) {
          const item = li.item && typeof li.item === 'object' ? li.item : li;
          if (types(item).some((x) => /Product/.test(x))) listItems.push(item);
        }
      }
      for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemOffered', 'isRelatedTo']) {
        if (node[key] && typeof node[key] === 'object') walk(node[key], depth + 1);
      }
    };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        walk(JSON.parse(s.textContent.replace(/[\u0000-\u001F]+/g, ' ')));
      } catch { /* malformed JSON-LD is common - ignore */ }
    }
    return { products, listItems, breadcrumbs };
  }

  function offerInfo(offers) {
    const list = [].concat(offers || []);
    for (const o of list) {
      const price = o.price ?? o.lowPrice ?? o.priceSpecification?.price;
      if (price !== undefined && price !== null && price !== '') {
        return { price: String(price), currency: o.priceCurrency || o.priceSpecification?.priceCurrency || '' };
      }
    }
    return { price: '', currency: '' };
  }

  function fromLdProduct(node, source = 'json-ld') {
    const { price, currency } = offerInfo(node.offers);
    const brand = typeof node.brand === 'string' ? node.brand : node.brand?.name || '';
    const images = [];
    ldImages(node.image).forEach((u, i) => pushImage(images, imageEntry(u, { score: 6 - Math.min(i, 3), source: 'structured' })));
    const variants = [].concat(node.hasVariant || []).slice(0, 30).map((v) => ({
      name: clean([v.color, v.size, v.pattern, v.material].filter(Boolean).join(' / ') || v.name || v.sku || '', 80),
      color: clean(v.color || '', 40),
      images: ldImages(v.image).map((u) => imageEntry(u, { score: 5, source: 'variant' })).filter(Boolean),
      url: abs(v.url || v.offers?.url),
    })).filter((v) => v.name || v.images.length);
    return {
      title: clean(node.name, 200),
      brand: clean(brand, 80),
      description: clean(node.description, 500),
      color: clean(typeof node.color === 'string' ? node.color : '', 60),
      category: clean(typeof node.category === 'string' ? node.category : node.category?.name || '', 120),
      price,
      currency,
      sku: clean(String(node.sku || node.mpn || ''), 60),
      groupId: String(node.productGroupID || node.inProductGroupWithID || node.isVariantOf?.productGroupID || ''),
      link: abs(node.url || node.offers?.url) || location.href,
      images,
      variants,
      source,
    };
  }

  // ---------- 2. Microdata ----------

  function parseMicrodata() {
    return [...document.querySelectorAll('[itemscope][itemtype*="schema.org/Product" i]')].slice(0, 5).map((el) => {
      const prop = (name) => {
        const p = el.querySelector(`[itemprop="${name}"]`);
        if (!p) return '';
        return p.getAttribute('content') || p.getAttribute('src') || p.getAttribute('href') || p.textContent;
      };
      const images = [];
      el.querySelectorAll('[itemprop="image"]').forEach((p) => {
        pushImage(images, imageEntry(p.getAttribute('content') || p.getAttribute('src') || p.getAttribute('href'), { score: 5, source: 'structured' }));
      });
      return {
        title: clean(prop('name'), 200),
        brand: clean(prop('brand'), 80),
        description: clean(prop('description'), 500),
        color: clean(prop('color'), 60),
        category: clean(prop('category'), 120),
        price: clean(prop('price'), 30),
        currency: clean(prop('priceCurrency'), 10),
        link: location.href,
        images,
        variants: [],
        source: 'microdata',
        element: el,
      };
    });
  }

  // ---------- 3. Open Graph / meta ----------

  function parseMeta() {
    const ogType = meta('og:type').toLowerCase();
    const images = [];
    [...metaAll('og:image'), ...metaAll('og:image:secure_url'), meta('twitter:image'), meta('twitter:image:src')]
      .forEach((u) => pushImage(images, imageEntry(u, { score: 4, source: 'meta' })));
    return {
      isProduct: /product/.test(ogType) || Boolean(meta('product:price:amount') || meta('og:price:amount')),
      title: clean(meta('og:title') || meta('twitter:title'), 200),
      description: clean(meta('og:description') || meta('description'), 500),
      price: clean(meta('product:price:amount') || meta('og:price:amount'), 30),
      currency: clean(meta('product:price:currency') || meta('og:price:currency'), 10),
      brand: clean(meta('product:brand') || meta('og:brand'), 80),
      color: clean(meta('product:color'), 60),
      images,
    };
  }

  // ---------- 4. DOM heuristics ----------

  function domImages() {
    const out = [];
    const imgs = [...document.images].slice(0, 600);
    for (const img of imgs) {
      if (img.closest('header, footer, nav, [role="banner"], [role="navigation"], [aria-hidden="true"]')) continue;
      const rect = img.getBoundingClientRect();
      const nw = img.naturalWidth || 0;
      const nh = img.naturalHeight || 0;
      const inGallery = Boolean(img.closest('[class*="gallery" i], [class*="carousel" i], [class*="slider" i], [class*="pdp" i], [class*="product-image" i], [class*="productimage" i], [class*="media" i], [id*="gallery" i], [data-testid*="image" i]'));
      const bigEnough = (rect.width >= 140 && rect.height >= 140) || (nw >= 300 && nh >= 300);
      if (!bigEnough && !(inGallery && (nw >= 60 || rect.width >= 40))) continue;
      const { best, fallback } = imgSources(img);
      const entry = best && imageEntry(best, {
        width: nw || Math.round(rect.width),
        height: nh || Math.round(rect.height),
        alt: clean(img.alt, 120),
        source: 'dom',
      });
      if (!entry) continue;
      if (fallback && fallback !== entry.url && !entry.fallbackUrl) entry.fallbackUrl = fallback;
      const area = Math.max(rect.width * rect.height, 1);
      const ratio = (nh || rect.height) / Math.max(nw || rect.width, 1);
      entry.score = Math.log10(area) + (ratio > 0.9 && ratio < 1.6 ? 0.6 : 0) + (inGallery ? 0.8 : 0) + (rect.top < innerHeight * 1.2 ? 0.5 : 0);
      entry.el = img;
      out.push(entry);
    }
    return out;
  }

  function findPrice(root) {
    const priceEl = root.querySelector('[itemprop="price"], [class*="price" i]:not([class*="old" i]):not([class*="was" i]):not([class*="strike" i]), [data-testid*="price" i]');
    const txt = priceEl ? priceEl.getAttribute('content') || priceEl.textContent : '';
    const m = (txt || '').match(PRICE_RE) || (txt.match(/\d[\d,.]*/) ? [txt.trim()] : null);
    return m ? clean(m[0], 30) : '';
  }

  function domBreadcrumbs() {
    const bc = document.querySelector('nav[aria-label*="breadcrumb" i], [class*="breadcrumb" i], ol[itemtype*="BreadcrumbList"]');
    if (!bc) return [];
    return [...bc.querySelectorAll('a, span, li')].map((e) => clean(e.textContent, 60)).filter((t, i, arr) => t && t.length < 60 && arr.indexOf(t) === i).slice(0, 8);
  }

  function domVariants() {
    const sel = [...document.querySelectorAll('select')].find((s) => /colou?r|shade|finish|variant/i.test(`${s.name} ${s.id} ${s.getAttribute('aria-label') || ''}`));
    if (sel) {
      return [...sel.options].map((o) => clean(o.textContent, 60)).filter((t) => t && !/select|choose/i.test(t)).slice(0, 20).map((name) => ({ name, images: [] }));
    }
    const swatches = [...document.querySelectorAll('[class*="swatch" i] [aria-label], [class*="color" i] [aria-label], [class*="colour" i] [aria-label]')]
      .map((e) => clean(e.getAttribute('aria-label'), 60)).filter((t, i, a) => t && t.length < 40 && a.indexOf(t) === i).slice(0, 20);
    return swatches.map((name) => ({ name, images: [] }));
  }

  // ---------- 5. Listing cards ----------

  function listingCards(excludeEls) {
    const cards = new Set();
    const imgs = [...document.images].filter((img) => {
      const r = img.getBoundingClientRect();
      return r.width >= 90 && r.height >= 90 && !img.closest('header, footer, nav');
    }).slice(0, 400);
    for (const img of imgs) {
      if (excludeEls.some((ex) => ex && ex.contains(img))) continue;
      let el = img;
      for (let depth = 0; depth < 8 && el; depth += 1) {
        el = el.parentElement;
        if (!el || el === document.body) break;
        const text = el.textContent || '';
        if (text.length > 900) break;
        const r = el.getBoundingClientRect();
        if (r.width > innerWidth * 0.7) break;
        if (PRICE_RE.test(text) && (el.querySelector('a[href]') || el.closest('a[href]'))) {
          cards.add(el);
          break;
        }
      }
    }
    const list = [...cards].filter((c) => ![...cards].some((o) => o !== c && c.contains(o)));
    return list.slice(0, MAX_PRODUCTS).map((card) => {
      const images = [];
      card.querySelectorAll('img').forEach((img, i) => {
        const r = img.getBoundingClientRect();
        if (r.width < 60 && i > 0) return;
        const { best, fallback } = imgSources(img);
        const e = best && imageEntry(best, { width: img.naturalWidth, height: img.naturalHeight, alt: clean(img.alt, 120), score: 3 - i * 0.5, source: 'listing' });
        if (e) {
          if (fallback && fallback !== e.url && !e.fallbackUrl) e.fallbackUrl = fallback;
          pushImage(images, e);
        }
      });
      const a = card.querySelector('a[href]') || card.closest('a[href]');
      const titleEl = card.querySelector('[class*="title" i], [class*="name" i], [itemprop="name"], h2, h3, h4');
      const title = clean(titleEl?.textContent || a?.getAttribute('title') || a?.getAttribute('aria-label') || card.querySelector('img')?.alt || a?.textContent || '', 160);
      const brand = clean(card.querySelector('[class*="brand" i]')?.textContent || '', 60);
      const priceMatch = (card.textContent || '').match(PRICE_RE);
      return {
        title,
        brand,
        description: '',
        price: priceMatch ? clean(priceMatch[0], 30) : '',
        currency: '',
        link: abs(a?.getAttribute('href')) || location.href,
        images,
        variants: [],
        source: 'listing',
        element: card,
      };
    }).filter((p) => p.images.length && p.title);
  }

  // ---------- assemble ----------

  function mergeInto(target, src) {
    for (const k of ['title', 'brand', 'description', 'color', 'category', 'price', 'currency', 'sku']) {
      if (!target[k] && src[k]) target[k] = src[k];
    }
    src.images?.forEach((img) => pushImage(target.images, img));
    if (!target.variants?.length && src.variants?.length) target.variants = src.variants;
  }

  function detect() {
    const started = performance.now();
    const ld = parseJsonLd();
    const md = parseMicrodata();
    const og = parseMeta();
    const breadcrumbs = ld.breadcrumbs.length ? ld.breadcrumbs : domBreadcrumbs();
    const h1 = clean(document.querySelector('h1')?.textContent, 200);
    const hasCartButton = [...document.querySelectorAll('button, input[type="submit"], a[role="button"]')]
      .slice(0, 300).some((b) => ADD_TO_CART.test(b.textContent || b.value || b.getAttribute('aria-label') || ''));

    // Structured primary products (dedupe variants sharing a product group)
    const structured = [];
    for (const node of ld.products) {
      const p = fromLdProduct(node);
      const sibling = structured.find((s) => (p.groupId && s.groupId === p.groupId) || (s.title && s.title === p.title));
      if (sibling) {
        mergeInto(sibling, p);
        if (p.color && !sibling.variants.some((v) => v.name === p.color)) {
          sibling.variants.push({ name: p.color, color: p.color, images: p.images.slice(0, 3), url: p.link });
        }
      } else {
        structured.push(p);
      }
    }
    md.forEach((m) => {
      const match = structured.find((s) => s.title && m.title && s.title === m.title);
      if (match) mergeInto(match, m);
      else if (m.title) structured.push(m);
    });

    const dom = domImages().sort((a, b) => b.score - a.score);
    let primary = null;
    const isProductPage = structured.length === 1 || og.isProduct || (hasCartButton && h1 && dom.length > 0 && structured.length <= 1);

    if (isProductPage) {
      primary = structured[0] || {
        title: og.title || h1 || clean(document.title, 200),
        brand: og.brand,
        description: og.description,
        color: og.color,
        price: og.price || findPrice(document.querySelector('main') || document.body),
        currency: og.currency,
        link: location.href,
        images: [],
        variants: [],
        source: og.isProduct ? 'meta' : 'heuristic',
      };
      mergeInto(primary, og);
      if (!primary.title) primary.title = h1;
      if (!primary.price) primary.price = findPrice(document.querySelector('main') || document.body);

      // Gallery = the best DOM image's nearest container holding several large images
      const top = dom[0];
      let galleryRoot = null;
      if (top) {
        let el = top.el;
        for (let i = 0; i < 7 && el; i += 1) {
          el = el.parentElement;
          if (!el || el.getBoundingClientRect().width > innerWidth * 0.75) break;
          const count = dom.filter((d) => el.contains(d.el)).length;
          if (count >= 2) galleryRoot = el;
        }
      }
      const structuredKeys = new Set(primary.images.map((i) => keyOf(i.url)));
      dom.forEach((d) => {
        const inGallery = galleryRoot ? galleryRoot.contains(d.el) : d === top;
        const matchesStructured = structuredKeys.has(keyOf(d.url));
        if (inGallery || matchesStructured) pushImage(primary.images, { ...d, el: undefined, score: d.score + (matchesStructured ? 2 : 0) });
      });
      if (!primary.variants.length) primary.variants = domVariants();
      primary.element = galleryRoot || top?.el || null;
      primary.breadcrumbs = breadcrumbs;
    }

    // Listing / related products
    const listing = [];
    if (!isProductPage || structured.length > 1) {
      structured.slice(isProductPage ? 1 : 0).forEach((s) => listing.push({ ...s, source: s.source + '-list' }));
      ld.listItems.forEach((n) => listing.push(fromLdProduct(n, 'json-ld-list')));
    }
    const domCards = listingCards([primary?.element]);
    domCards.forEach((c) => {
      const dup = listing.find((l) => (l.link && l.link === c.link) || (l.images[0] && c.images[0] && keyOf(l.images[0].url) === keyOf(c.images[0].url)));
      if (dup) {
        mergeInto(dup, c);
        dup.element = dup.element || c.element;
      } else if (!primary || c.link !== primary.link) {
        listing.push(c);
      }
    });

    const products = [primary, ...listing].filter((p) => p && p.images.length && p.title).slice(0, MAX_PRODUCTS);
    const seenIds = new Set();
    const output = products.map((p, idx) => {
      p.images.sort((a, b) => (b.score || 0) - (a.score || 0));
      const id = `p${idx}-${keyOf(p.images[0].url).slice(-24).replace(/[^a-z0-9]/gi, '')}`;
      if (p.element) p.element.setAttribute('data-tryon-id', id);
      seenIds.add(id);
      return {
        id,
        title: p.title,
        brand: p.brand || '',
        description: p.description || '',
        color: p.color || '',
        category: p.category || '',
        price: p.price ? `${p.currency && !/[^\d.,\s]/.test(p.price) ? `${p.currency} ` : ''}${p.price}` : '',
        link: p.link || location.href,
        source: p.source,
        isPrimary: p === primary,
        breadcrumbs: p === primary ? breadcrumbs : [],
        images: p.images.slice(0, 12).map(({ url, fallbackUrl, width, height, alt, score, source }) => ({ url, fallbackUrl, width, height, alt, score: Math.round((score || 0) * 100) / 100, source })),
        variants: (p.variants || []).slice(0, 20).map((v) => ({ name: v.name, color: v.color || '', url: v.url || null, images: (v.images || []).slice(0, 4).map(({ url, fallbackUrl }) => ({ url, fallbackUrl })) })),
      };
    });

    return {
      page: {
        url: location.href,
        host: location.hostname.replace(/^www\./, ''),
        title: clean(document.title, 200),
        type: isProductPage ? (listing.length ? 'product+related' : 'product') : output.length ? 'listing' : 'unknown',
        signals: { jsonLd: ld.products.length, microdata: md.length, openGraph: og.isProduct, cartButton: hasCartButton, listingCards: domCards.length },
      },
      products: output,
      tookMs: Math.round(performance.now() - started),
    };
  }

  let overlay = null;
  function highlight(id) {
    const el = document.querySelector(`[data-tryon-id="${CSS.escape(id)}"]`);
    if (!el) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    overlay?.remove();
    overlay = document.createElement('div');
    const place = () => {
      const r = el.getBoundingClientRect();
      Object.assign(overlay.style, {
        position: 'fixed', left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px`,
        border: '3px solid #7c3aed', borderRadius: '10px', boxShadow: '0 0 0 9999px rgba(124,58,237,0.08)', zIndex: 2147483647,
        pointerEvents: 'none', transition: 'all .2s ease',
      });
    };
    document.documentElement.appendChild(overlay);
    place();
    const timer = setInterval(place, 100);
    setTimeout(() => {
      clearInterval(timer);
      overlay?.remove();
      overlay = null;
    }, 2200);
    return true;
  }

  globalThis.__tryOnAI = { version: VERSION, detect, highlight };
})();
