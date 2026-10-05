import { autoScene, getCatalog, getCategory } from './catalog.js';

/**
 * Choose which profile photos to send for the requested products.
 * Returns { primary, supporting[] } where each entry is a stored photo record.
 * Category config lists preferred slots in priority order (catalog.json -> photos).
 */
export function selectProfilePhotos(photosBySlot, items) {
  const available = (slot) => photosBySlot[slot] || null;
  let order;
  if (items.length > 1) {
    order = ['full', 'upper', 'lower', 'face'];
  } else {
    order = [...getCategory(items[0].category).photos, 'full', 'upper', 'face', 'lower', 'feet', 'hands'];
  }
  order = [...new Set(order)];
  const primary = order.map(available).find(Boolean);
  if (!primary) return null;

  const supporting = [];
  const wanted = items.length > 1 ? ['face'] : [...getCategory(items[0].category).photos, 'face', 'full'];
  for (const slot of [...new Set(wanted)]) {
    const p = available(slot);
    if (p && p.id !== primary.id && !supporting.some((s) => s.id === p.id) && supporting.length < 2) supporting.push(p);
  }
  return { primary, supporting };
}

export function resolveScene(scene, items) {
  const { scenes } = getCatalog();
  const mode = scene?.mode || 'auto';
  if (mode === 'custom' && scene.text?.trim()) {
    return { key: 'custom', label: 'Custom', prompt: scene.text.trim().slice(0, 300) };
  }
  if (mode === 'original') {
    return { key: 'original', label: 'My photo background', prompt: null };
  }
  const key = mode === 'auto' ? autoScene(items) : scenes[mode] ? mode : 'studio';
  return { key, label: scenes[key].label, prompt: scenes[key].prompt };
}

const slotLabel = (slot) => getCatalog().photoSlots[slot]?.label || slot;

function describeItem(item, idx) {
  const cat = getCategory(item.category);
  const facts = [
    item.brand && `brand: ${item.brand}`,
    item.color && `colour: ${item.color}`,
    item.variant && `variant: ${item.variant}`,
    item.description && `description: ${item.description}`,
  ].filter(Boolean);
  return `PRODUCT ${idx + 1} - ${cat.label}: "${item.title || 'Untitled product'}"${facts.length ? ` (${facts.join('; ')})` : ''}.`;
}

/**
 * Build an ordered list of prompt parts. Text parts label each image so the model
 * knows exactly which image is the person and which is the product.
 * Image parts are placeholders resolved by the job runner: { image: { kind, id } }.
 */
export function buildPrompt({ profile, photos, items, scene }) {
  const parts = [];
  const multi = items.length > 1;
  const verbs = [...new Set(items.map((i) => getCategory(i.category).verb))].join('/');
  const framing = !multi && getCategory(items[0].category).framing;

  parts.push({
    text:
      'You are an expert virtual try-on system and professional fashion photographer. ' +
      `Generate ONE new photorealistic photograph of the person shown in the PERSON images ${verbs} the product${multi ? 's' : ''} shown in the PRODUCT images. ` +
      'The image roles are labelled below.',
  });

  parts.push({ text: `PERSON - main reference photo (${slotLabel(photos.primary.slot)}). This is the customer; keep their identity:` });
  parts.push({ image: { kind: 'photo', id: photos.primary.id } });
  for (const p of photos.supporting) {
    parts.push({ text: `PERSON - additional reference of the SAME person (${slotLabel(p.slot)}), use for identity/body detail only:` });
    parts.push({ image: { kind: 'photo', id: p.id } });
  }

  items.forEach((item, idx) => {
    parts.push({ text: describeItem(item, idx) });
    item.imageIds.forEach((imgId, n) => {
      parts.push({ text: n === 0 ? `PRODUCT ${idx + 1} - main product photo:` : `PRODUCT ${idx + 1} - additional view of the same product:` });
      parts.push({ image: { kind: 'product', id: imgId } });
    });
  });

  const placement = items.map((item, idx) => `- Product ${idx + 1}: ${getCategory(item.category).placement}`).join('\n');
  const personNotes = [
    profile.heightCm && `The person is about ${profile.heightCm} cm tall.`,
    profile.fitPreference && `Preferred fit: ${profile.fitPreference}.`,
    profile.notes && `Notes from the customer: ${profile.notes}.`,
  ].filter(Boolean).join(' ');

  let sceneText;
  if (scene.key === 'original') {
    sceneText = 'Keep the background, lighting and setting of the main PERSON photo. Keep a similar pose.';
  } else {
    sceneText =
      `Place the person in ${scene.prompt}. Choose a natural, flattering pose suited to the product and setting ` +
      '(a slight variation of the reference pose is fine), with lighting, shadows and colour grading consistent with the environment.';
  }

  parts.push({
    text: [
      'INSTRUCTIONS',
      'IDENTITY: The output must clearly be the same person - preserve face, facial features, skin tone, hair style and colour, body shape, proportions and age. Do not beautify, slim or change ethnicity.',
      'PRODUCT FIDELITY (most important): Reproduce each product exactly as in its product photos - identical colours, patterns, prints, logos, text, materials, stitching, hardware, cut and proportions. Do NOT invent a different or generic design. Take only the product from the product photos and ignore any model, mannequin, hanger or background shown there.',
      `PLACEMENT:\n${placement}`,
      multi ? 'OUTFIT: Combine all products into one coherent outfit worn at the same time; keep the person\'s own clothes only where no product covers them.' : 'Keep the rest of the person\'s clothing plausible and unobtrusive so the product is the focus.',
      `SCENE: ${sceneText}`,
      framing ? `FRAMING: ${framing}, with the product clearly visible and in focus.` : 'FRAMING: Frame the shot so the whole product is clearly visible and in focus.',
      personNotes && `PERSON DETAILS: ${personNotes}`,
      'REALISM: Natural fit with realistic folds, drape, scale, perspective, contact shadows and occlusion (e.g. hair or arms in front of the product where natural). It must look like a real photograph, not a collage or a pasted cut-out.',
      'OUTPUT: A single photograph only. No text, captions, watermarks, borders, split screens or multiple panels.',
    ].filter(Boolean).join('\n'),
  });

  return parts;
}
