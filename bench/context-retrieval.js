// Benchmark for the document-context retrieval pipeline (src/context-docs.js).
//
//   node bench/context-retrieval.js            # standard scales
//   node bench/context-retrieval.js --huge     # adds the 80 MB / 100k-chunk case
//   node --expose-gc bench/context-retrieval.js   # accurate memory figures
//
// Measures three things that matter for a live-call copilot:
//   • latency  — chunking + indexing at load, and per-query search time
//   • memory   — resident cost of holding the index
//   • quality  — whether the right passage actually comes back
//
// Quality is scored against planted "needle" facts: one sentence, phrased with
// terms that occur nowhere else, asked about with a question that is not a
// substring of the fact. recall@1 is the number that matters — the prompt only
// carries a handful of passages, so a fact ranked 30th is a fact Veil never sees.

const { chunkText, buildIndex, search, MAX_SNIPPETS } = require('../src/context-docs');
const { makeCorpus, makeDistractorQueries } = require('./corpus');

const HUGE = process.argv.includes('--huge');
const JSON_OUT = process.argv.includes('--json');

// docCount × charsPerDoc is the corpus size. The store caps a user at 50 docs of
// 400k chars (20 MB); "large" is that ceiling, "huge" is 4x beyond it as headroom.
const SCALES = [
  { label: 'small',  docCount: 5,   charsPerDoc: 12000,  needles: 40 },
  { label: 'medium', docCount: 25,  charsPerDoc: 100000, needles: 100 },
  { label: 'large',  docCount: 50,  charsPerDoc: 400000, needles: 200 }
];
if (HUGE) SCALES.push({ label: 'huge', docCount: 200, charsPerDoc: 400000, needles: 300 });

function mb(bytes) { return bytes / 1024 / 1024; }

function gc() {
  if (global.gc) { global.gc(); global.gc(); }
}

function heap() {
  gc();
  return process.memoryUsage().heapUsed;
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function runScale(scale) {
  const { docs, needles } = makeCorpus({
    docCount: scale.docCount,
    charsPerDoc: scale.charsPerDoc,
    needleCount: scale.needles,
    seed: 42
  });

  const totalChars = docs.reduce((n, d) => n + d.text.length, 0);

  // Everything the loaded library costs, measured from before chunking: the
  // chunk text is retained too, so counting only buildIndex()'s own allocations
  // would flatter the result.
  const before = heap();

  // ---- chunking ----
  const tChunk = process.hrtime.bigint();
  const prepared = docs.map((d, i) => ({ id: 'd' + i, name: d.name, chunks: chunkText(d.text) }));
  const chunkMs = Number(process.hrtime.bigint() - tChunk) / 1e6;
  const chunkCount = prepared.reduce((n, d) => n + d.chunks.length, 0);

  // ---- indexing ----
  const tIndex = process.hrtime.bigint();
  const index = buildIndex(prepared);
  const indexMs = Number(process.hrtime.bigint() - tIndex) / 1e6;
  const indexBytes = heap() - before;

  // ---- search: latency + quality ----
  const times = [];
  let hitAt1 = 0, hitAt3 = 0, hitAtK = 0, rrSum = 0, empties = 0;

  for (const n of needles) {
    const t0 = process.hrtime.bigint();
    const hits = search(index, n.query);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);

    if (!hits.length) { empties++; continue; }
    // The needle's terms appear in exactly one chunk, so containment is exact.
    const rank = hits.findIndex((h) => h.text.includes(n.text));
    if (rank === 0) hitAt1++;
    if (rank >= 0 && rank < 3) hitAt3++;
    if (rank >= 0) { hitAtK++; rrSum += 1 / (rank + 1); }
  }

  // ---- silence on unanswerable questions ----
  const distractors = makeDistractorQueries(200, 7);
  let falseFires = 0;
  for (const q of distractors) {
    const t0 = process.hrtime.bigint();
    if (search(index, q).length) falseFires++;
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }

  times.sort((a, b) => a - b);
  const n = needles.length;

  return {
    label: scale.label,
    docs: docs.length,
    mbText: mb(totalChars),
    chunks: chunkCount,
    terms: Object.keys(index.df).length,
    chunkMs,
    indexMs,
    loadMs: chunkMs + indexMs,
    indexMB: mb(indexBytes),
    p50: pct(times, 50),
    p95: pct(times, 95),
    p99: pct(times, 99),
    max: times[times.length - 1],
    recall1: hitAt1 / n,
    recall3: hitAt3 / n,
    recallK: hitAtK / n,
    mrr: rrSum / n,
    missed: (n - hitAtK) / n,
    empties,
    falseFireRate: falseFires / distractors.length
  };
}

function table(rows, cols) {
  const head = cols.map((c) => c.h);
  const body = rows.map((r) => cols.map((c) => c.f(r)));
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  console.log(line(head));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const b of body) console.log(line(b));
}

// --sweep: vary the relevance floor and show the recall/false-fire trade-off, so
// MIN_IDF_MASS is picked from the curve rather than guessed.
if (process.argv.includes('--sweep')) {
  const wanted = (process.argv.find((a) => a.startsWith('--scale=')) || '').split('=')[1] || 'medium';
  const scale = SCALES.find((s) => s.label === wanted) || SCALES[1];
  const { docs, needles } = makeCorpus({
    docCount: scale.docCount, charsPerDoc: scale.charsPerDoc, needleCount: scale.needles, seed: 42
  });
  const index = buildIndex(docs.map((d, i) => ({ id: 'd' + i, name: d.name, chunks: chunkText(d.text) })));
  const distractors = makeDistractorQueries(200, 7);

  const rows = [];
  for (const mass of [0.5, 0.75, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0]) {
    let hit = 0;
    for (const nd of needles) {
      const hits = search(index, nd.query, { minIdfMass: mass });
      if (hits.some((h) => h.text.includes(nd.text))) hit++;
    }
    const fires = distractors.filter((q) => search(index, q, { minIdfMass: mass }).length).length;
    rows.push({ mass, recall: hit / needles.length, ff: fires / distractors.length });
  }
  console.log(`relevance-floor sweep on the "${scale.label}" corpus (${index.n.toLocaleString()} chunks)\n`);
  table(rows, [
    { h: 'MIN_IDF_MASS', f: (r) => r.mass.toFixed(2) },
    { h: 'recall', f: (r) => (r.recall * 100).toFixed(1) + '%' },
    { h: 'false-fire', f: (r) => (r.ff * 100).toFixed(1) + '%' }
  ]);
  process.exit(0);
}

const results = SCALES.map((s) => {
  process.stderr.write(`running ${s.label}…\n`);
  return runScale(s);
});

if (JSON_OUT) {
  console.log(JSON.stringify(results, null, 2));
} else {
  if (!global.gc) console.log('note: run with `node --expose-gc` for accurate index memory\n');

  console.log('SCALE / COST  (one-time, on the background warm-up — not on the answer path)\n');
  table(results, [
    { h: 'corpus', f: (r) => r.label },
    { h: 'docs', f: (r) => String(r.docs) },
    { h: 'text MB', f: (r) => r.mbText.toFixed(1) },
    { h: 'chunks', f: (r) => r.chunks.toLocaleString() },
    { h: 'terms', f: (r) => r.terms.toLocaleString() },
    { h: 'chunk ms', f: (r) => r.chunkMs.toFixed(0) },
    { h: 'index ms', f: (r) => r.indexMs.toFixed(0) },
    { h: 'warm ms', f: (r) => r.loadMs.toFixed(0) },
    { h: 'resident MB', f: (r) => r.indexMB.toFixed(0) }
  ]);

  console.log('\nQUERY LATENCY  (ms, per question asked)\n');
  table(results, [
    { h: 'corpus', f: (r) => r.label },
    { h: 'p50', f: (r) => r.p50.toFixed(2) },
    { h: 'p95', f: (r) => r.p95.toFixed(2) },
    { h: 'p99', f: (r) => r.p99.toFixed(2) },
    { h: 'max', f: (r) => r.max.toFixed(2) }
  ]);

  console.log('\nRETRIEVAL QUALITY  (planted facts, 1 correct passage each)\n');
  table(results, [
    { h: 'corpus', f: (r) => r.label },
    { h: 'recall@1', f: (r) => (r.recall1 * 100).toFixed(1) + '%' },
    { h: 'recall@3', f: (r) => (r.recall3 * 100).toFixed(1) + '%' },
    { h: `recall@${MAX_SNIPPETS}`, f: (r) => (r.recallK * 100).toFixed(1) + '%' },
    { h: 'MRR', f: (r) => r.mrr.toFixed(3) },
    { h: 'missed', f: (r) => (r.missed * 100).toFixed(1) + '%' },
    { h: 'false-fire', f: (r) => (r.falseFireRate * 100).toFixed(1) + '%' }
  ]);

  console.log('\nfalse-fire = returned passages for a question the corpus cannot answer (lower is better).');
  console.log('missed     = the planted fact was not in the returned passages at all.');
}
