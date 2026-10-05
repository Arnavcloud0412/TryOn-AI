import { Router } from 'express';
import { registerUser, requireAuth } from '../auth.js';
import { db } from '../db/index.js';
import { blobs, keys } from '../blobs.js';
import { provider } from '../ai/index.js';
import { HttpError, ah, sha256 } from '../util.js';

const router = Router();

router.post('/auth/register', ah(async (req, res) => {
  const ipHash = sha256(`ip:${req.ip || ''}`).slice(0, 16);
  const hourAgo = Date.now() - 3600_000;
  const recent = (await db.find('users', { ipHash })).filter((u) => new Date(u.createdAt).getTime() > hourAgo);
  if (recent.length >= 20) throw new HttpError(429, 'RATE_LIMITED', 'Too many registrations from this address.');
  const { user, token } = await registerUser(req.ip);
  res.status(201).json({ token, userId: user.id });
}));

router.get('/me', requireAuth, ah(async (req, res) => {
  const u = req.user;
  const [profiles, photos, results] = await Promise.all([
    db.find('profiles', { userId: u.id }),
    db.find('photos', { userId: u.id }),
    db.find('results', { userId: u.id }),
  ]);
  res.json({
    id: u.id,
    createdAt: u.createdAt,
    consentTraining: u.consentTraining,
    activeProfileId: u.activeProfileId,
    counts: { profiles: profiles.length, photos: photos.length, results: results.length },
  });
}));

router.patch('/me', requireAuth, ah(async (req, res) => {
  const changes = {};
  if (typeof req.body.consentTraining === 'boolean') changes.consentTraining = req.body.consentTraining;
  if (typeof req.body.activeProfileId === 'string') {
    const p = await db.get('profiles', req.body.activeProfileId);
    if (!p || p.userId !== req.user.id) throw new HttpError(404, 'PROFILE_NOT_FOUND', 'Profile not found.');
    changes.activeProfileId = p.id;
  }
  await db.patch('users', req.user.id, changes);
  res.json({ ok: true, ...changes });
}));

/** Right to erasure: removes every profile, photo, result, stored file and the account itself. */
router.delete('/me', requireAuth, ah(async (req, res) => {
  const uid = req.user.id;
  const photos = await db.find('photos', { userId: uid });
  await Promise.all(photos.flatMap((p) => Object.values(p.providerCache || {}).map((c) => provider.deleteRemoteFile(c))));
  await blobs.delPrefix(keys.userPrefix(uid));
  await Promise.all(['photos', 'profiles', 'results'].map((c) => db.removeWhere(c, { userId: uid })));
  await db.remove('users', uid);
  res.json({ ok: true, deleted: true });
}));

export default router;
