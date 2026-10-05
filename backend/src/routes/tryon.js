import { Router } from 'express';
import { waitUntil } from '@vercel/functions';
import { db } from '../db/index.js';
import { blobs } from '../blobs.js';
import { checkStale, createTryOn, publicResult } from '../jobs.js';
import { deleteResult } from './profiles.js';
import { HttpError, ah } from '../util.js';

const router = Router();

async function ownResult(req) {
  const r = await db.get('results', req.params.id);
  if (!r || r.userId !== req.user.id) throw new HttpError(404, 'RESULT_NOT_FOUND', 'Result not found.');
  return r;
}

router.post('/tryon', ah(async (req, res) => {
  const { job, run } = await createTryOn(req.user, req.body || {});
  // Keeps the function alive after the response until generation finishes.
  if (run) waitUntil(run());
  res.status(job.cached ? 200 : 202).json(job);
}));

router.get('/tryon/:id', ah(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await publicResult(await checkStale(await ownResult(req))));
}));

router.get('/results', ah(async (req, res) => {
  const { profileId } = req.query;
  const filter = { userId: req.user.id, status: 'done', ...(profileId ? { profileId: String(profileId) } : {}) };
  const list = (await db.find('results', filter))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 200);
  res.json({ results: await Promise.all(list.map(publicResult)) });
}));

router.get('/results/:id/image', ah(async (req, res) => {
  const r = await ownResult(req);
  const thumb = req.query.size === 'thumb';
  const buffer = r.status === 'done' && (await blobs.get(thumb ? r.thumbKey : r.blobKey));
  if (!buffer) throw new HttpError(404, 'IMAGE_NOT_READY', 'Result image not available.');
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.type(thumb || r.ext === 'jpg' ? 'image/jpeg' : 'image/png').send(buffer);
}));

router.delete('/results/:id', ah(async (req, res) => {
  await deleteResult(await ownResult(req));
  res.json({ ok: true });
}));

router.delete('/results', ah(async (req, res) => {
  const mine = await db.find('results', { userId: req.user.id });
  await Promise.all(mine.map(deleteResult));
  res.json({ ok: true, deleted: mine.length });
}));

export default router;
