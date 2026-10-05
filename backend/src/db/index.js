import { config } from '../config.js';
import * as postgres from './postgres.js';
import * as local from './local.js';

/**
 * Document store used by the whole backend:
 *   get(collection, id) · find(collection, filter) · put(collection, doc)
 *   patch(collection, id, changes) · remove(collection, id) · removeWhere(collection, filter)
 * `filter` is shallow equality on top-level fields.
 * Collections: users, profiles, photos, productImages, results (see docs/ARCHITECTURE.md).
 */
if (config.onVercel && !config.databaseUrl) {
  console.error('[db] DATABASE_URL is not set. Connect a Neon Postgres database to this Vercel project.');
}

export const db = config.databaseUrl ? postgres : local;
export const dbDriver = config.databaseUrl ? 'postgres' : 'local-json';
