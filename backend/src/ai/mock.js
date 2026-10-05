import { sideBySide } from '../images.js';
import { sleep } from '../util.js';

/**
 * Offline provider used when no AI key is configured. It exercises the whole
 * pipeline (photo selection, product retrieval, jobs, storage, UI) and returns a
 * labelled composite instead of a generated image.
 */
export async function generate(parts, { onStage = async () => {} } = {}) {
  await onStage('uploading');
  await sleep(600);
  await onStage('generating');
  await sleep(2500);
  const images = parts.filter((p) => p.image);
  const person = images.find((p) => p.image.kind === 'photo');
  const products = images.filter((p) => p.image.kind === 'product').map((p) => p.image.buffer);
  const buffer = await sideBySide(person.image.buffer, products, 'DEMO MODE - set GEMINI_API_KEY for real AI try-on');
  return { buffer, mime: 'image/png', text: 'mock', model: 'mock' };
}

export async function deleteRemoteFile() {}
