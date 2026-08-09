const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmbedder, normalize, dot, OPENAI_MODEL, GEMINI_MODEL } = require('../src/embeddings');

test('vectors are normalised to unit length so similarity is a plain dot product', () => {
  const v = normalize(Float32Array.from([3, 4]));
  assert.ok(Math.abs(Math.hypot(v[0], v[1]) - 1) < 1e-6);
  assert.ok(Math.abs(v[0] - 0.6) < 1e-6);
});

test('normalising a zero vector does not divide by zero', () => {
  const v = normalize(Float32Array.from([0, 0, 0]));
  assert.deepEqual([...v], [0, 0, 0]);
});

test('dot of identical unit vectors is 1, of orthogonal ones is 0', () => {
  const a = normalize(Float32Array.from([1, 1]));
  const b = normalize(Float32Array.from([1, 1]));
  const c = normalize(Float32Array.from([1, -1]));
  assert.ok(Math.abs(dot(a, b) - 1) < 1e-6);
  assert.ok(Math.abs(dot(a, c)) < 1e-6);
});

test('dot compares only the overlapping length rather than throwing', () => {
  assert.equal(dot(Float32Array.from([1, 0, 0]), Float32Array.from([1, 0])), 1);
});

test('no embedding-capable key means no embedder, not a crash', () => {
  const e = createEmbedder({ apiKeys: {} });
  assert.equal(e.ready, false);
  assert.equal(e.provider, null);
});

// Anthropic has no embeddings API, so an Anthropic-only user keeps keyword-only
// retrieval. This must degrade quietly rather than look broken.
test('an Anthropic-only key cannot embed', () => {
  const e = createEmbedder({ provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-x' } });
  assert.equal(e.ready, false);
});

test('OpenAI is used when its key is present', () => {
  const e = createEmbedder({ provider: 'openai', apiKeys: { openai: 'sk-x' } });
  assert.equal(e.ready, true);
  assert.equal(e.provider, 'openai');
  assert.equal(e.model, OPENAI_MODEL);
  assert.equal(e.dims, 512);
});

test('a Gemini user embeds with Gemini rather than being pushed to OpenAI', () => {
  const e = createEmbedder({ provider: 'gemini', apiKeys: { gemini: 'AIza-x', openai: 'sk-x' } });
  assert.equal(e.provider, 'gemini');
  assert.equal(e.model, GEMINI_MODEL);
});

test('an Anthropic user with an OpenAI key still gets embeddings from it', () => {
  const e = createEmbedder({ provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-x', openai: 'sk-x' } });
  assert.equal(e.ready, true);
  assert.equal(e.provider, 'openai');
});

// The id is what decides whether stored vectors are still comparable. If it did
// not change with the model, switching provider would silently mix vectors from
// two different spaces and quietly wreck retrieval.
test('the embedder id changes when the provider or model does', () => {
  const a = createEmbedder({ provider: 'openai', apiKeys: { openai: 'sk-x' } });
  const b = createEmbedder({ provider: 'gemini', apiKeys: { gemini: 'AIza-x' } });
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /openai/);
  assert.match(b.id, /gemini/);
});
