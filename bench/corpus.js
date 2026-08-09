// Synthetic corpus generator for the retrieval benchmark.
//
// Real English is Zipf-distributed: a handful of words dominate and a long tail
// appears once or twice. That distribution is what BM25's IDF term reacts to, so
// a corpus of uniformly-random words would make retrieval look far better than it
// is in practice. The generator below matches the shape well enough to be a fair
// test, and is fully deterministic so runs are comparable.

// mulberry32 — small, fast, deterministic.
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLL_A = ['ba', 'de', 'fi', 'go', 'hu', 'ka', 'le', 'mo', 'ni', 'pa', 're', 'so', 'ta', 'vu', 'we', 'zi'];
const SYLL_B = ['nt', 'rk', 'st', 'ld', 'mp', 'ng', 'sh', 'ct', 'lm', 'rn'];
const SYLL_C = ['er', 'ion', 'al', 'ing', 'ate', 'ic', 'ous', 'ment', 'ity', 'ance'];

function coinWord(r) {
  let w = SYLL_A[(r() * SYLL_A.length) | 0];
  if (r() < 0.75) w += SYLL_B[(r() * SYLL_B.length) | 0];
  if (r() < 0.6) w += SYLL_A[(r() * SYLL_A.length) | 0];
  if (r() < 0.5) w += SYLL_C[(r() * SYLL_C.length) | 0];
  return w;
}

/**
 * A vocabulary plus a Zipf sampler over it.
 * rank-1 word appears ~size/1 times, rank-n ~size/n — i.e. natural-language shape.
 */
function makeVocab(size, seed) {
  const r = rng(seed);
  const words = [];
  const seen = new Set();
  while (words.length < size) {
    const w = coinWord(r);
    if (w.length >= 3 && !seen.has(w)) { seen.add(w); words.push(w); }
  }
  // Precompute the cumulative Zipf distribution once; sampling is then a binary search.
  const cum = new Float64Array(size);
  let total = 0;
  for (let i = 0; i < size; i++) { total += 1 / (i + 1); cum[i] = total; }
  for (let i = 0; i < size; i++) cum[i] /= total;

  return {
    words,
    sample(rand) {
      const x = rand();
      let lo = 0, hi = size - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < x) lo = mid + 1; else hi = mid;
      }
      return words[lo];
    }
  };
}

// A "needle" is a fact planted in exactly one place in the corpus, phrased with
// terms that appear nowhere else. Retrieving it is the thing we score.
function makeNeedle(r, i) {
  const tag = 'zq' + i.toString(36);
  const subject = tag + 'protocol';
  const object = tag + 'ledger';
  const value = 100 + ((r() * 900) | 0);
  return {
    id: i,
    // The sentence as it appears in the document.
    text: `The ${subject} reconciles the ${object} every ${value} minutes without operator input.`,
    // How a user would ask about it — deliberately not a substring of the fact.
    query: `how often does the ${subject} reconcile the ${object}?`,
    terms: [subject, object]
  };
}

/**
 * Builds one document of roughly `chars` characters, with markdown headings and
 * paragraph structure, and the given needles planted at random paragraph slots.
 */
function makeDoc(name, chars, needles, seed, echoTerms = []) {
  const r = rng(seed);
  const vocab = makeVocab(4000, seed ^ 0x9e37);
  const parts = [];
  let len = 0;
  let paraIndex = 0;

  // Where the needles go — spread across the document, never all at the front.
  const slots = new Set();
  const approxParas = Math.max(needles.length + 1, Math.ceil(chars / 420));
  for (let i = 0; i < needles.length; i++) {
    slots.add(1 + Math.floor((approxParas - 2) * ((i + 0.5) / needles.length)));
  }
  const bySlot = new Map();
  [...slots].sort((a, b) => a - b).forEach((s, i) => bySlot.set(s, needles[i]));

  while (len < chars) {
    // A heading must never consume a slot a needle was assigned to, or the fact
    // is silently never planted and the run scores a miss the retriever never
    // had a chance at.
    if (paraIndex % 9 === 0 && !bySlot.has(paraIndex)) {
      const h = '## ' + cap(vocab.sample(r)) + ' ' + cap(vocab.sample(r));
      parts.push(h);
      len += h.length + 2;
      paraIndex++;
      continue;
    }

    const needle = bySlot.get(paraIndex);
    let para;
    if (needle) {
      // Surround the fact with ordinary prose so it isn't a chunk on its own.
      para = sentence(r, vocab, 12) + ' ' + needle.text + ' ' + sentence(r, vocab, 14);
    } else {
      const n = 2 + ((r() * 3) | 0);
      const sents = [];
      for (let i = 0; i < n; i++) sents.push(sentence(r, vocab, 10 + ((r() * 12) | 0)));
      para = sents.join(' ');
      // "Echoes": other passages that mention a needle's topic word without
      // containing the fact. Real topic words are not corpus-unique, and a
      // retriever that only works when a term appears exactly once is being
      // graded on an easier problem than the one it actually faces.
      if (echoTerms.length && r() < 0.25) {
        const t = echoTerms[(r() * echoTerms.length) | 0];
        para += ' ' + cap(t) + ' ' + sentence(r, vocab, 8);
      }
    }
    parts.push(para);
    len += para.length + 2;
    paraIndex++;
  }

  return { name, text: parts.join('\n\n') };
}

function sentence(r, vocab, words) {
  const out = [];
  for (let i = 0; i < words; i++) out.push(vocab.sample(r));
  return cap(out.join(' ')) + '.';
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/**
 * A whole corpus: `docCount` documents of `charsPerDoc`, with `needleCount`
 * facts distributed across them.
 *
 * @returns {{docs: Array<{name,text}>, needles: Array}}
 */
function makeCorpus({ docCount, charsPerDoc, needleCount, seed = 1 }) {
  const r = rng(seed ^ 0x5bf03);
  const needles = [];
  for (let i = 0; i < needleCount; i++) needles.push(makeNeedle(r, i));

  // Every needle's topic words are echoed elsewhere in the corpus, so the
  // retriever has to pick the passage holding the fact out of a field of
  // passages merely mentioning the topic.
  const echoTerms = needles.flatMap((n) => n.terms);

  const docs = [];
  for (let d = 0; d < docCount; d++) {
    // Deal the needles round-robin so they land in different documents.
    const mine = needles.filter((_, i) => i % docCount === d);
    docs.push(makeDoc(`doc-${String(d).padStart(3, '0')}.md`, charsPerDoc, mine, seed + d * 7919, echoTerms));
  }
  return { docs, needles };
}

// Queries that no document can answer — used to measure how often retrieval
// fires when it should stay silent.
function makeDistractorQueries(count, seed) {
  const r = rng(seed ^ 0x1234);
  const vocab = makeVocab(4000, 0xbeef); // a vocabulary the corpus never used
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(`what is the ${vocab.sample(r)} for ${vocab.sample(r)} ${vocab.sample(r)}?`);
  }
  return out;
}

module.exports = { rng, makeVocab, makeCorpus, makeDistractorQueries };
