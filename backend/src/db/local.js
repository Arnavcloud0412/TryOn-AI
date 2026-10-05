import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Local-development driver: a JSON file with the same document semantics as the
 * Postgres driver. Never used on Vercel (the filesystem there is read-only/ephemeral).
 */
const file = path.join(config.dataDir, 'db.json');
let data = null;
let timer = null;

function load() {
  if (data) return data;
  data = {};
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
      console.error('[db/local] corrupt db.json backed up', err.message);
    }
  }
  return data;
}

function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
    fs.renameSync(`${file}.tmp`, file);
  }, 100);
}

const coll = (name) => {
  const d = load();
  d[name] ||= {};
  return d[name];
};

const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => doc[k] === v);
const clone = (v) => (v ? structuredClone(v) : null);

export async function get(collection, id) {
  return clone(coll(collection)[id]);
}

export async function find(collection, filter = {}) {
  return Object.values(coll(collection)).filter((d) => matches(d, filter)).map(clone);
}

export async function put(collection, doc) {
  coll(collection)[doc.id] = clone(doc);
  save();
  return doc;
}

export async function patch(collection, id, changes) {
  const doc = coll(collection)[id];
  if (!doc) return null;
  Object.assign(doc, clone(changes));
  save();
  return clone(doc);
}

export async function remove(collection, id) {
  delete coll(collection)[id];
  save();
}

export async function removeWhere(collection, filter) {
  const c = coll(collection);
  for (const [id, doc] of Object.entries(c)) if (matches(doc, filter)) delete c[id];
  save();
}
