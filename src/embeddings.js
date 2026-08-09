// embeddings.js — optional semantic retrieval, behind one interface.
//
// Keyword search (src/context-docs.js) is exact and instant, and it is very good
// when the question reuses the document's own words. It is blind when it doesn't:
// asking "what's our uptime promise?" against a page that only ever says "service
// level agreement" shares no content terms at all, so BM25 scores it zero.
//
// Embeddings close that gap by comparing meaning instead of spelling. They cost
// money and a network round trip, so they are strictly optional — everything here
// degrades to "no vectors" rather than failing a request.
//
// Anthropic has no embeddings API, so a user on Anthropic keeps keyword-only
// retrieval unless they also supply an OpenAI or Gemini key.

// 512 dimensions rather than the default 1536: OpenAI's v3 models are trained so
// a truncated prefix stays useful, and it cuts stored vectors to a quarter the
// size for a negligible quality loss at this corpus scale.
const OPENAI_MODEL = 'text-embedding-3-small';
const OPENAI_DIMS = 512;
const GEMINI_MODEL = 'text-embedding-004';
const GEMINI_DIMS = 768;

// Requests are batched. The cap is on both count and characters because the
// provider limits total tokens per call, and a batch of long passages hits that
// long before a batch of short ones.
const BATCH_SIZE = 96;
const BATCH_CHARS = 32000;

/**
 * @param {object} settings
 * @returns {{ready:boolean, provider:string|null, model:string|null, dims:number,
 *            id:string, embed:(texts:string[], opts?)=>Promise<Float32Array[]>}}
 */
function createEmbedder(settings) {
  const keys = (settings && settings.apiKeys) || {};
  // Prefer whichever provider the user is already using for chat, so the same
  // key covers both; otherwise fall back to any key that can embed at all.
  const order = settings && settings.provider === 'gemini'
    ? ['gemini', 'openai']
    : ['openai', 'gemini'];
  const provider = order.find((p) => keys[p]) || null;

  if (!provider) {
    return { ready: false, provider: null, model: null, dims: 0, id: '', async embed() { return []; } };
  }

  const model = provider === 'openai' ? OPENAI_MODEL : GEMINI_MODEL;
  const dims = provider === 'openai' ? OPENAI_DIMS : GEMINI_DIMS;

  return {
    ready: true,
    provider,
    model,
    dims,
    // Stored alongside the vectors. If the user switches provider or we change
    // model, this no longer matches and the vectors are rebuilt rather than
    // silently compared across incompatible spaces.
    id: `${provider}:${model}:${dims}`,
    embed: (texts, opts) => embedBatched(provider, keys[provider], model, dims, texts, opts || {})
  };
}

async function embedBatched(provider, apiKey, model, dims, texts, opts) {
  const out = [];
  let batch = [];
  let chars = 0;

  const flush = async () => {
    if (!batch.length) return;
    const vectors = provider === 'openai'
      ? await embedOpenAI(apiKey, model, dims, batch)
      : await embedGemini(apiKey, model, batch);
    out.push(...vectors);
    batch = [];
    chars = 0;
    if (opts.onProgress) opts.onProgress(out.length, texts.length);
  };

  for (const t of texts) {
    const text = clean(t);
    if (batch.length >= BATCH_SIZE || (chars + text.length) > BATCH_CHARS) await flush();
    batch.push(text);
    chars += text.length;
  }
  await flush();
  return out;
}

// An all-whitespace or empty input is rejected by both providers, and a passage
// that long is well past the point where more text sharpens the vector.
function clean(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 8000) : '(empty)';
}

async function embedOpenAI(apiKey, model, dims, input) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey });
  const res = await client.embeddings.create({ model, input, dimensions: dims });
  // The API documents that results come back in input order, but it also returns
  // an explicit index — use it rather than trusting the ordering.
  const sorted = res.data.slice().sort((a, b) => a.index - b.index);
  return sorted.map((d) => normalize(Float32Array.from(d.embedding)));
}

async function embedGemini(apiKey, model, contents) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.embedContent({ model, contents });
  const list = (res && res.embeddings) || [];
  return list.map((e) => normalize(Float32Array.from(e.values || [])));
}

// Vectors are stored unit-length so similarity is a plain dot product — no
// per-comparison magnitude work in the search loop.
function normalize(v) {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const n = Math.sqrt(sum);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

// Dot product of two unit vectors == cosine similarity.
function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

module.exports = {
  createEmbedder,
  normalize,
  dot,
  OPENAI_MODEL,
  OPENAI_DIMS,
  GEMINI_MODEL,
  GEMINI_DIMS,
  BATCH_SIZE
};
