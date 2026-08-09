// Measures the paraphrase gap: questions worded differently from the document
// that answers them.
//
//   node bench/semantic.js              # keyword baseline only, no API calls
//   node bench/semantic.js --embed      # also measures real embeddings ($)
//
// --embed reads the API key from your Veil settings and issues real requests to
// OpenAI or Gemini. It costs a fraction of a cent. Without the flag nothing
// leaves the machine and only the keyword baseline is reported.

const path = require('path');
const { chunkText, buildIndex, search } = require('../src/context-docs');
const { DOC, PARAPHRASE_QUERIES, LITERAL_QUERIES } = require('./paraphrase');

const WITH_EMBED = process.argv.includes('--embed');

function buildCorpus() {
  const docs = [{ id: 'd1', name: 'handbook.md', chunks: chunkText(DOC) }];
  return { index: buildIndex(docs), chunks: docs[0].chunks };
}

function evaluate(index, queries, queryVectors) {
  let hit = 0;
  const misses = [];
  queries.forEach(([q, needle], i) => {
    const opts = queryVectors ? { queryVector: queryVectors[i] } : {};
    const hits = search(index, q, opts);
    if (hits.some((h) => h.text.includes(needle))) hit++;
    else misses.push(q);
  });
  return { rate: hit / queries.length, hit, total: queries.length, misses };
}

function line(label, r) {
  return `  ${label.padEnd(26)} ${String(r.hit).padStart(2)}/${r.total}   ${(r.rate * 100).toFixed(0).padStart(3)}%`;
}

(async () => {
  const { index, chunks } = buildCorpus();
  console.log(`corpus: ${chunks.length} passages from one handbook\n`);

  console.log('KEYWORD ONLY (BM25)');
  const litKw = evaluate(index, LITERAL_QUERIES);
  const parKw = evaluate(index, PARAPHRASE_QUERIES);
  console.log(line('literal wording', litKw));
  console.log(line('paraphrased wording', parKw));
  if (parKw.misses.length) {
    console.log('\n  missed when paraphrased:');
    parKw.misses.forEach((m) => console.log('    · ' + m));
  }

  if (!WITH_EMBED) {
    console.log('\nRun with --embed to measure the semantic path (issues real API calls).');
    return;
  }

  // Load the user's key the same way the app does.
  const { app } = require('electron');
  const settings = require('../src/store').getSettings();
  const { createEmbedder } = require('../src/embeddings');
  const embedder = createEmbedder(settings);
  if (!embedder.ready) {
    console.log('\nNo OpenAI or Gemini key in settings — cannot measure the semantic path.');
    return;
  }

  console.log(`\nembedding ${chunks.length} passages with ${embedder.provider} ${embedder.model}…`);
  const texts = chunks.map((c) => (c.heading ? c.heading + '\n' : '') + c.text);
  const vectors = await embedder.embed(texts);
  index.vectors = new Map(vectors.map((v, i) => [i, v]));

  const embedQueries = async (qs) => embedder.embed(qs.map(([q]) => q));
  const litVecs = await embedQueries(LITERAL_QUERIES);
  const parVecs = await embedQueries(PARAPHRASE_QUERIES);

  console.log('\nKEYWORD + SEMANTIC (RRF fusion)');
  const litHy = evaluate(index, LITERAL_QUERIES, litVecs);
  const parHy = evaluate(index, PARAPHRASE_QUERIES, parVecs);
  console.log(line('literal wording', litHy));
  console.log(line('paraphrased wording', parHy));
  if (parHy.misses.length) {
    console.log('\n  still missed:');
    parHy.misses.forEach((m) => console.log('    · ' + m));
  }

  const delta = (parHy.rate - parKw.rate) * 100;
  console.log(`\nparaphrase recall: ${(parKw.rate * 100).toFixed(0)}% → ${(parHy.rate * 100).toFixed(0)}%  (${delta >= 0 ? '+' : ''}${delta.toFixed(0)} points)`);
  if (litHy.rate < litKw.rate) {
    console.log(`WARNING: literal recall regressed ${(litKw.rate * 100).toFixed(0)}% → ${(litHy.rate * 100).toFixed(0)}% — fusion is hurting the case keyword search already handled.`);
  } else {
    console.log('literal recall held — fusion did not damage what keyword search already got right.');
  }
})();
