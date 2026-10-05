// Product-category classification using the keyword lists served by the
// backend catalog (so new categories need no extension update).

const reCache = new Map();
function wordRe(kw) {
  if (!reCache.has(kw)) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[-\s]/g, '[-\\s]?');
    reCache.set(kw, new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, 'i'));
  }
  return reCache.get(kw);
}

function urlPath(link) {
  try {
    return decodeURIComponent(new URL(link).pathname).replace(/[-_/]+/g, ' ');
  } catch {
    return '';
  }
}

/**
 * @returns {{ key: string, confidence: number }}
 */
export function classify(product, categories) {
  const fields = [
    [product.title, 3],
    [product.category, 2.5],
    [(product.breadcrumbs || []).join(' '), 2],
    [urlPath(product.link), 1],
    [(product.images || []).map((i) => i.alt).join(' '), 0.5],
    [product.description, 0.5],
  ];
  const scores = {};
  for (const [key, cat] of Object.entries(categories || {})) {
    let s = 0;
    for (const kw of cat.keywords || []) {
      const re = wordRe(kw);
      for (const [text, weight] of fields) {
        if (text && re.test(text)) s += weight * (1 + kw.length / 10);
      }
    }
    if (s > 0) scores[key] = s;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { key: 'accessories', confidence: 0 };
  const [best, second] = ranked;
  const confidence = Math.min(1, best[1] / 6) * (second ? Math.min(1, (best[1] - second[1]) / best[1] + 0.4) : 1);
  return { key: best[0], confidence: Math.round(confidence * 100) / 100 };
}
