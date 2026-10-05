import catalog from '../catalog/catalog.js';

/**
 * Categories, profile photo slots and scenes are data, not code (catalog/catalog.js).
 * The extension downloads the catalog at runtime (GET /api/config), so adding a
 * category only requires redeploying the backend - never rebuilding the extension.
 */
export const getCatalog = () => catalog;

export function getCategory(key) {
  return catalog.categories[key] || catalog.categories.accessories;
}

const wordRe = (kw) => new RegExp(`(^|[^a-z])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');

/** Pick a scene key for the given products based on scene keywords, falling back to the category default. */
export function autoScene(items) {
  const text = items
    .map((i) => [i.title, i.description, (i.breadcrumbs || []).join(' ')].join(' '))
    .join(' ')
    .toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const [key, scene] of Object.entries(catalog.scenes)) {
    const score = (scene.keywords || []).reduce((s, kw) => s + (wordRe(kw).test(text) ? 1 : 0), 0);
    if (score > bestScore) {
      best = key;
      bestScore = score;
    }
  }
  if (best) return best;
  return getCategory(items[0]?.category).defaultScene || 'casual';
}
