import { neon } from '@neondatabase/serverless';
import { config } from '../config.js';

/**
 * Serverless Postgres (Neon via the Vercel Marketplace) over HTTP - no
 * connection pool to exhaust from short-lived function instances.
 * Schema: see db/schema.sql. Documents are stored as JSONB per collection.
 */
let sql = null;
let ready = null;

function client() {
  if (!sql) sql = neon(config.databaseUrl);
  return sql;
}

function init() {
  if (!ready) {
    ready = (async () => {
      const q = client();
      await q.query(`CREATE TABLE IF NOT EXISTS docs (
        collection text NOT NULL,
        id text NOT NULL,
        data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (collection, id)
      )`);
      await q.query('CREATE INDEX IF NOT EXISTS docs_data_gin ON docs USING gin (data jsonb_path_ops)');
    })().catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

async function query(text, params) {
  await init();
  return client().query(text, params);
}

export async function get(collection, id) {
  const rows = await query('SELECT data FROM docs WHERE collection = $1 AND id = $2', [collection, id]);
  return rows[0]?.data || null;
}

export async function find(collection, filter = {}) {
  const rows = await query('SELECT data FROM docs WHERE collection = $1 AND data @> $2::jsonb', [collection, JSON.stringify(filter)]);
  return rows.map((r) => r.data);
}

export async function put(collection, doc) {
  await query(
    `INSERT INTO docs (collection, id, data) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [collection, doc.id, JSON.stringify(doc)],
  );
  return doc;
}

/** Atomic shallow merge (JSONB ||), safe for concurrent progress updates. */
export async function patch(collection, id, changes) {
  const rows = await query(
    'UPDATE docs SET data = data || $3::jsonb, updated_at = now() WHERE collection = $1 AND id = $2 RETURNING data',
    [collection, id, JSON.stringify(changes)],
  );
  return rows[0]?.data || null;
}

export async function remove(collection, id) {
  await query('DELETE FROM docs WHERE collection = $1 AND id = $2', [collection, id]);
}

export async function removeWhere(collection, filter) {
  await query('DELETE FROM docs WHERE collection = $1 AND data @> $2::jsonb', [collection, JSON.stringify(filter)]);
}
