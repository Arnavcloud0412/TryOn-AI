import crypto from 'node:crypto';

export const newId = (prefix = '') => `${prefix}${crypto.randomBytes(9).toString('base64url')}`;

export const sha256 = (input) => crypto.createHash('sha256').update(input).digest('hex');

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Wrap async express handlers so rejected promises reach the error middleware. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function clampText(value, max = 500) {
  if (typeof value !== 'string') return '';
  const s = value.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
