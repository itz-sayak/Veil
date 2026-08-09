// context-store.js — on-disk library of user-uploaded reference documents, plus
// the retrieval entry point used when building a prompt.
//
// Like src/store.js this is plain fs + JSON, no native modules. Documents live in
// their own directory rather than inside veil-data.json deliberately: that file is
// read, deep-merged and rewritten on every settings change, and document text
// would make each of those a multi-megabyte round trip.
//
//   <userData>/context/
//     index.json    metadata for every document
//     <id>.json     the chunks of one document

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const {
  chunkText, search, buildQuery, formatDocsBlock,
  createIndexBuilder, addDocToIndex, finalizeIndex
} = require('./context-docs');

const DIR = path.join(app.getPath('userData'), 'context');
const INDEX_FILE = path.join(DIR, 'index.json');

const ALLOWED_EXT = ['.md', '.markdown', '.txt', '.text', '.pdf'];
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_DOC_CHARS = 400000;
// 200 documents is ~76 MB of text and ~143k passages at the per-document cap.
// bench/context-retrieval.js measures that case: ~10 s to index (in the
// background, off the answer path), ~200 MB resident, and query latency still
// p99 < 3 ms with retrieval quality unchanged from a five-document library.
const MAX_DOCS = 200;

// Ids are always generated here, never accepted from the renderer, and every
// path is rebuilt from a validated id — a document can't be made to point
// outside DIR.
const ID_RE = /^d[a-z0-9]+$/;

let meta = null;         // { version, docs: [...] }
let cachedIndex = null;  // invalidated by every mutation
let warming = null;      // in-flight warm-up promise, if any
let generation = 0;      // bumped by every mutation, so a stale build can bail

// ── metadata file ────────────────────────────────────────────────────────────

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) { /* surfaced on write */ }
}

function loadMeta() {
  if (meta) return meta;
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    meta = { version: 1, docs: Array.isArray(raw.docs) ? raw.docs.filter((d) => d && ID_RE.test(d.id)) : [] };
  } catch (_) {
    meta = { version: 1, docs: [] };
  }
  return meta;
}

function saveMeta() {
  ensureDir();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(meta, null, 2));
  // Invalidate: the cached index, and any warm-up currently building the old set.
  cachedIndex = null;
  warming = null;
  generation++;
}

function chunkFile(id) {
  if (!ID_RE.test(id)) throw new Error('bad document id');
  return path.join(DIR, id + '.json');
}

// ── public: listing and mutation ─────────────────────────────────────────────

function listDocs() {
  return loadMeta().docs.map((d) => ({ ...d }));
}

/**
 * Ingests one file: validate → extract text → chunk → persist.
 * Re-uploading a file with the same name replaces the previous version.
 *
 * @param {{name:string, buffer:Buffer|Uint8Array}} file
 * @returns {Promise<{ok:boolean, doc?:object, error?:string}>}
 */
async function addDoc(file) {
  const name = path.basename(String((file && file.name) || '')).trim();
  if (!name) return { ok: false, error: 'Missing file name.' };

  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) {
    return { ok: false, error: `${name}: unsupported file type. Veil reads .md, .txt and .pdf.` };
  }

  const buffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer || []);
  if (!buffer.length) return { ok: false, error: `${name} is empty.` };
  if (buffer.length > MAX_FILE_BYTES) {
    return { ok: false, error: `${name} is larger than ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.` };
  }

  const docs = loadMeta().docs;
  const replacing = docs.findIndex((d) => d.name.toLowerCase() === name.toLowerCase());
  if (replacing < 0 && docs.length >= MAX_DOCS) {
    return { ok: false, error: `Document limit reached (${MAX_DOCS}). Remove one first.` };
  }

  let text;
  try {
    if (ext === '.pdf') {
      const { extractPdfText } = require('./pdf-text');
      text = await extractPdfText(buffer);
      if (!text.trim()) {
        return { ok: false, error: `${name}: no extractable text — is it a scan? Veil can't OCR images.` };
      }
    } else {
      // Strip a UTF-8 BOM; Windows editors add one and it would otherwise land
      // at the head of the first chunk.
      text = buffer.toString('utf8').replace(/^﻿/, '');
    }
  } catch (e) {
    return { ok: false, error: `${name}: ${e && e.message ? e.message : String(e)}` };
  }

  if (text.length > MAX_DOC_CHARS) text = text.slice(0, MAX_DOC_CHARS);

  const chunks = chunkText(text);
  if (!chunks.length) return { ok: false, error: `${name}: no readable text found.` };

  const id = replacing >= 0 ? docs[replacing].id : 'd' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
  const record = {
    id,
    name,
    ext,
    bytes: buffer.length,
    chars: text.length,
    chunkCount: chunks.length,
    addedAt: Date.now(),
    enabled: replacing >= 0 ? docs[replacing].enabled !== false : true
  };

  ensureDir();
  fs.writeFileSync(chunkFile(id), JSON.stringify({ id, name, chunks }));
  if (replacing >= 0) docs[replacing] = record; else docs.push(record);
  saveMeta();

  return { ok: true, doc: record, replaced: replacing >= 0 };
}

function deleteDoc(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: 'Not found' };
  const docs = loadMeta().docs;
  const idx = docs.findIndex((d) => d.id === id);
  if (idx < 0) return { ok: false, error: 'Not found' };
  docs.splice(idx, 1);
  saveMeta();
  try { fs.unlinkSync(chunkFile(id)); } catch (_) { /* metadata is the source of truth */ }
  return { ok: true, docs: listDocs() };
}

function setDocEnabled(id, on) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: 'Not found' };
  const doc = loadMeta().docs.find((d) => d.id === id);
  if (!doc) return { ok: false, error: 'Not found' };
  doc.enabled = !!on;
  saveMeta();
  return { ok: true, docs: listDocs() };
}

// ── retrieval ────────────────────────────────────────────────────────────────

function enabledDocIds() {
  return loadMeta().docs.filter((d) => d.enabled !== false).map((d) => d.id);
}

function readDoc(id) {
  const d = loadMeta().docs.find((x) => x.id === id);
  if (!d) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(chunkFile(id), 'utf8'));
    return { id, name: d.name, chunks: raw.chunks || [] };
  } catch (_) {
    // Chunk file missing or corrupt — skip it rather than failing the request.
    return null;
  }
}

/**
 * Builds the index one document at a time, yielding to the event loop between
 * documents.
 *
 * Measured on a 76 MB / 143k-chunk library, indexing takes ~10 s. Doing that
 * synchronously on the first question would both freeze the main process — the
 * overlay, the audio pipeline, everything — and stall the answer. Warming it in
 * the background at startup means it is ready long before anyone asks anything,
 * and the yields keep the app responsive while it runs.
 */
function warmIndex() {
  if (cachedIndex) return Promise.resolve(cachedIndex);
  if (warming) return warming;

  const startedAt = generation;
  const ids = enabledDocIds();

  warming = (async () => {
    const b = createIndexBuilder();
    for (const id of ids) {
      // A document was added, removed or toggled while we were building — this
      // pass is describing a library that no longer exists.
      if (generation !== startedAt) return null;
      const doc = readDoc(id);
      if (doc) addDocToIndex(b, doc);
      await new Promise((r) => setImmediate(r));
    }
    if (generation !== startedAt) return null;
    cachedIndex = finalizeIndex(b);
    return cachedIndex;
  })();

  const inFlight = warming;
  return warming
    .catch((e) => { if (warming === inFlight) warming = null; throw e; })
    .then((idx) => {
      if (warming === inFlight) warming = null;
      return idx || warmIndex(); // abandoned mid-build: rebuild the new set
    });
}

/**
 * The prompt fragment for one request, or null when there is nothing to add.
 * Callers treat any rejection as "no context" — retrieval must never cost a reply.
 */
async function buildDocsContext({ mode, transcript, userText, settings }) {
  // Coding problems get no personal or document context, matching the same
  // early-out in buildInterviewContext().
  if (mode === 'leetcode') return null;
  if (!settings || !settings.contextDocs || settings.contextDocs.enabled === false) return null;
  if (!loadMeta().docs.some((d) => d.enabled !== false)) return null;

  // Cheap checks first: no point waiting on a warm-up for a query that could
  // never retrieve anything.
  const query = buildQuery({ userText, transcript });
  if (!query.trim()) return null;

  // Normally already warm from startup; if a build is still in flight this waits
  // only for the remainder of it.
  const index = cachedIndex || await warmIndex();
  if (!index || !index.n) return null;

  const block = formatDocsBlock(search(index, query));
  return block || null;
}

function hasEnabledDocs() {
  return loadMeta().docs.some((d) => d.enabled !== false);
}

module.exports = {
  DIR,
  ALLOWED_EXT,
  MAX_FILE_BYTES,
  MAX_DOCS,
  listDocs,
  addDoc,
  deleteDoc,
  setDocEnabled,
  buildDocsContext,
  warmIndex,
  hasEnabledDocs
};
