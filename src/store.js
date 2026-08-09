// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
//
// Secrets (API keys) are encrypted at rest with Electron safeStorage — OS-backed
// encryption (DPAPI on Windows, Keychain on macOS, libsecret on Linux). In memory
// the store still exposes plaintext keys so the rest of the app is unchanged; only
// the on-disk file holds ciphertext.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { DEFAULT_MODES } = require('./modes');
const { DEFAULT_KEYBINDS, LEGACY_BAD_KEYBINDS } = require('./keybinds');

const FILE = path.join(app.getPath('userData'), 'veil-data.json');

const DEFAULTS = {
  provider: 'openai',
  smart: false,
  apiKeys: { openai: '', anthropic: '', gemini: '', deepgram: '' },
  // Persona modes (see src/modes.js) + which one is active
  modes: { activeId: 'general', list: DEFAULT_MODES },
  // Customisable global shortcuts (see src/keybinds.js)
  keybinds: { ...DEFAULT_KEYBINDS },
  // Screen-share / capture invisibility toggle
  undetectability: true,
  // Uploaded reference documents. Only the master on/off switch lives here — the
  // document list and its text live in <userData>/context/ (see context-store.js)
  // so this file stays small enough to rewrite on every settings change.
  contextDocs: { enabled: true },
  // Response language ('en' = default English)
  language: 'en',
  onboarded: false,
  // NOTE: keybindsVersion is deliberately NOT defaulted here — migrateKeybinds must
  // see the *persisted* version (undefined for old files) to know it needs to run.
  // Tab 2: Profile
  resumeText: '',
  jobDescription: '',
  // Tab 3: Interview Prep
  starStories: '',       // 3-5 behavioral STAR stories in plain English
  whyCompany: '',        // Why do you want to work here?
  whyLeaving: '',        // Why are you leaving your current job?
  workStyle: '',         // How you work, decision-making style, values
  // Tab 4: Q&A
  salaryTarget: '',      // e.g. "$150k-$180k base + equity"
  questionsToAsk: '',    // Questions to ask the interviewer
  // Window position
  windowX: null,
  windowY: null,
  models: {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' },
    gemini: { fast: 'gemini-2.0-flash', smart: 'gemini-2.0-flash' }
  }
};

let data = null;

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

// -------- secret encryption --------
function encryptionAvailable() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); }
  catch (_) { return false; }
}

// Encode a plaintext secret for disk. "enc:" = OS-encrypted, "plain:" = base64
// fallback when no OS keyring is available (still not stored as bare plaintext).
function encStr(s) {
  if (!s) return '';
  if (encryptionAvailable()) {
    try { return 'enc:' + safeStorage.encryptString(s).toString('base64'); }
    catch (_) { /* fall through */ }
  }
  return 'plain:' + Buffer.from(String(s), 'utf8').toString('base64');
}

// Decode a stored secret back to plaintext. Bare values (no prefix) are treated
// as plaintext written before encryption at rest was added.
function decStr(v) {
  if (!v || typeof v !== 'string') return '';
  if (v.startsWith('enc:')) {
    try { return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); }
    catch (_) { return ''; }
  }
  if (v.startsWith('plain:')) {
    try { return Buffer.from(v.slice(6), 'base64').toString('utf8'); }
    catch (_) { return ''; }
  }
  return v; // legacy plaintext
}

function decryptKeysInPlace(d) {
  if (d && d.apiKeys) {
    for (const k of Object.keys(d.apiKeys)) d.apiKeys[k] = decStr(d.apiKeys[k]);
  }
}

// Build a disk-serialisable clone with secrets encrypted.
function serialize(d) {
  const clone = JSON.parse(JSON.stringify(d));
  if (clone.apiKeys) {
    for (const k of Object.keys(clone.apiKeys)) clone.apiKeys[k] = encStr(d.apiKeys[k]);
  }
  return clone;
}

function readRaw() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (_) { return {}; } // nothing saved yet
}

function load() {
  if (data) return data;
  data = deepMerge(DEFAULTS, readRaw() || {});
  decryptKeysInPlace(data);
  // Persist immediately if stale keybinds were upgraded, so the fix survives a
  // crash before the next settings write.
  if (migrateKeybinds(data)) { try { save(); } catch (_) { /* ignore */ } }
  return data;
}

// Replace persisted copies of keybinds that are known not to register (old
// defaults that the OS/other apps already hold) with the current default for
// that action. Idempotent — runs every load, saves only when it changes
// something. User customisations that aren't in the known-bad set are untouched.
function migrateKeybinds(d) {
  if (!d) return false;
  d.keybinds = d.keybinds || {};
  let changed = false;
  for (const [action, badValue] of Object.entries(LEGACY_BAD_KEYBINDS)) {
    if (d.keybinds[action] === badValue) { d.keybinds[action] = DEFAULT_KEYBINDS[action]; changed = true; }
  }
  return changed;
}

function save() {
  try { fs.writeFileSync(FILE, JSON.stringify(serialize(data), null, 2)); }
  catch (e) { /* ignore */ }
}

module.exports = {
  getSettings() { return load(); },
  setSettings(patch) { load(); data = deepMerge(data, patch || {}); save(); return data; },
  encryptionAvailable
};
