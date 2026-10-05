-- TryOn AI database schema (Neon / any Postgres 14+).
-- The backend creates this automatically on first use; this file is for reference
-- and for manual setup (psql "$DATABASE_URL" -f db/schema.sql).
--
-- Each row is one document of a collection, stored as JSONB:
--   users          { id, tokenHash, consentTraining, activeProfileId, createdAt }
--   profiles       { id, userId, name, heightCm, fitPreference, notes, createdAt, updatedAt }
--   photos         { id, userId, profileId, slot, blobKey, width, height, sha256, warnings[],
--                    providerCache: { gemini: { name, uri, expiresAt } }, createdAt }
--   productImages  { id, sourceUrl, origin, blobKey, sha256, width, height, fetchedAt }
--   results        { id, userId, profileId, status, stage, items[], scene, photoIds[],
--                    provider, model, fast, cacheKey, blobKey, thumbKey, error,
--                    createdAt, generationStartedAt, completedAt, durationMs, generationMs }
-- Binary data (photos, product images, results) lives in a PRIVATE Vercel Blob store;
-- documents only hold blob keys.

CREATE TABLE IF NOT EXISTS docs (
  collection text        NOT NULL,
  id         text        NOT NULL,
  data       jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);

-- Supports equality filters such as data @> '{"userId": "u_..."}'
CREATE INDEX IF NOT EXISTS docs_data_gin ON docs USING gin (data jsonb_path_ops);
