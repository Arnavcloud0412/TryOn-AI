import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { blobs, keys } from '../blobs.js';
import { getCatalog } from '../catalog.js';
import { normalizeProfilePhoto } from '../images.js';
import { provider } from '../ai/index.js';
import { HttpError, ah, clampText, newId } from '../util.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.images.maxUploadBytes, files: 1 } });

async function ownProfile(req) {
  const p = await db.get('profiles', req.params.id);
  if (!p || p.userId !== req.user.id) throw new HttpError(404, 'PROFILE_NOT_FOUND', 'Profile not found.');
  return p;
}

async function publicProfile(p) {
  const photos = (await db.find('photos', { profileId: p.id })).map((ph) => ({
    slot: ph.slot,
    width: ph.width,
    height: ph.height,
    updatedAt: ph.createdAt,
    warnings: ph.warnings || [],
  }));
  return {
    id: p.id,
    name: p.name,
    heightCm: p.heightCm || null,
    fitPreference: p.fitPreference || '',
    notes: p.notes || '',
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    photos,
  };
}

function readProfileFields(body) {
  const out = {};
  if (body.name !== undefined) out.name = clampText(body.name, 60) || 'My profile';
  if (body.heightCm !== undefined) {
    const h = Number(body.heightCm);
    out.heightCm = Number.isFinite(h) && h >= 50 && h <= 250 ? Math.round(h) : null;
  }
  if (body.fitPreference !== undefined) out.fitPreference = clampText(body.fitPreference, 40);
  if (body.notes !== undefined) out.notes = clampText(body.notes, 200);
  return out;
}

async function deletePhoto(photo) {
  await Promise.all(Object.values(photo.providerCache || {}).map((c) => provider.deleteRemoteFile(c)));
  await blobs.del([photo.blobKey]);
  await db.remove('photos', photo.id);
}

export async function deleteResult(r) {
  await blobs.del([r.blobKey, r.thumbKey]);
  await db.remove('results', r.id);
}

router.get('/profiles', ah(async (req, res) => {
  const list = (await db.find('profiles', { userId: req.user.id })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  res.json({ profiles: await Promise.all(list.map(publicProfile)), activeProfileId: req.user.activeProfileId });
}));

router.post('/profiles', ah(async (req, res) => {
  if ((await db.find('profiles', { userId: req.user.id })).length >= 6) {
    throw new HttpError(400, 'PROFILE_LIMIT', 'You can have up to 6 profiles.');
  }
  const now = new Date().toISOString();
  const profile = await db.put('profiles', {
    id: newId('p_'),
    userId: req.user.id,
    name: 'My profile',
    ...readProfileFields(req.body),
    createdAt: now,
    updatedAt: now,
  });
  if (!req.user.activeProfileId) await db.patch('users', req.user.id, { activeProfileId: profile.id });
  res.status(201).json(await publicProfile(profile));
}));

router.patch('/profiles/:id', ah(async (req, res) => {
  const p = await ownProfile(req);
  const updated = await db.patch('profiles', p.id, { ...readProfileFields(req.body), updatedAt: new Date().toISOString() });
  res.json(await publicProfile(updated));
}));

router.delete('/profiles/:id', ah(async (req, res) => {
  const p = await ownProfile(req);
  for (const photo of await db.find('photos', { profileId: p.id })) await deletePhoto(photo);
  for (const r of await db.find('results', { profileId: p.id })) await deleteResult(r);
  await db.remove('profiles', p.id);
  if (req.user.activeProfileId === p.id) {
    const [next] = await db.find('profiles', { userId: req.user.id });
    await db.patch('users', req.user.id, { activeProfileId: next?.id || null });
  }
  res.json({ ok: true });
}));

router.put('/profiles/:id/photos/:slot', upload.single('photo'), ah(async (req, res) => {
  const p = await ownProfile(req);
  const { slot } = req.params;
  if (!getCatalog().photoSlots[slot]) throw new HttpError(400, 'INVALID_SLOT', `Unknown photo slot "${slot}".`);
  if (!req.file) throw new HttpError(400, 'NO_FILE', 'Attach an image in the "photo" field.');

  const norm = await normalizeProfilePhoto(req.file.buffer);
  const [existing] = await db.find('photos', { profileId: p.id, slot });
  if (existing && existing.sha256 === norm.sha256) return res.json(await publicProfile(p));
  if (existing) await deletePhoto(existing);

  const id = newId('ph_');
  const photo = {
    id,
    userId: req.user.id,
    profileId: p.id,
    slot,
    blobKey: keys.photo(req.user.id, id),
    width: norm.width,
    height: norm.height,
    sha256: norm.sha256,
    warnings: norm.warnings,
    providerCache: {},
    createdAt: new Date().toISOString(),
  };
  await blobs.put(photo.blobKey, norm.buffer, 'image/jpeg');
  await db.put('photos', photo);
  await db.patch('profiles', p.id, { updatedAt: photo.createdAt });
  res.json(await publicProfile(p));
}));

router.get('/profiles/:id/photos/:slot', ah(async (req, res) => {
  const p = await ownProfile(req);
  const [photo] = await db.find('photos', { profileId: p.id, slot: req.params.slot });
  const buffer = photo && (await blobs.get(photo.blobKey));
  if (!buffer) throw new HttpError(404, 'PHOTO_NOT_FOUND', 'Photo not found.');
  res.set('Cache-Control', 'private, max-age=3600');
  res.type('image/jpeg').send(buffer);
}));

router.delete('/profiles/:id/photos/:slot', ah(async (req, res) => {
  const p = await ownProfile(req);
  const [photo] = await db.find('photos', { profileId: p.id, slot: req.params.slot });
  if (photo) await deletePhoto(photo);
  res.json(await publicProfile(p));
}));

export default router;
