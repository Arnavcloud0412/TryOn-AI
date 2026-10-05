import crypto from 'node:crypto';
import { db } from './db/index.js';
import { HttpError, newId, sha256 } from './util.js';

/**
 * Anonymous device accounts: the extension registers once and receives a random
 * 256-bit bearer token. Only the SHA-256 hash of the token is stored server-side.
 */
export async function registerUser(ip) {
  const token = crypto.randomBytes(32).toString('base64url');
  const user = {
    id: newId('u_'),
    tokenHash: sha256(token),
    ipHash: sha256(`ip:${ip || ''}`).slice(0, 16),
    createdAt: new Date().toISOString(),
    consentTraining: false,
    activeProfileId: null,
  };
  await db.put('users', user);
  return { user, token };
}

export async function requireAuth(req, _res, next) {
  try {
    const header = req.get('authorization') || '';
    const match = header.match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/);
    if (!match) throw new HttpError(401, 'UNAUTHENTICATED', 'Missing or malformed bearer token');
    const [user] = await db.find('users', { tokenHash: sha256(match[1]) });
    if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Unknown token. Re-register the extension.');
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
