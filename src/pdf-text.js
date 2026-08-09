// pdf-text.js — text extraction from PDFs, isolated from the rest of the context
// pipeline so a pdfjs failure surfaces as "couldn't read this PDF" rather than
// taking down document ingest as a whole.
//
// pdfjs-dist is ESM-only and this project is CommonJS, so it is pulled in with a
// dynamic import(). The module is cached after the first load — the import costs
// a beat, and ingest is already async.

const path = require('path');

let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    // The "legacy" build is the one that runs outside a browser.
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsPromise;
}

// pdfjs warns on every document unless it is told where the Type1 metrics live.
// Resolved from the installed package so it keeps working once electron-builder
// has relocated node_modules into the app bundle. pdfjs treats this as a URL and
// rejects it without a trailing forward slash, so no path.sep here on Windows.
function standardFontDataUrl() {
  try {
    const pkg = require.resolve('pdfjs-dist/package.json');
    return path.join(path.dirname(pkg), 'standard_fonts').replace(/\\/g, '/') + '/';
  } catch (_) {
    return undefined;
  }
}

/**
 * Extracts the visible text of a PDF, one blank-line-separated block per page.
 *
 * Returns '' for a PDF that carries no text layer at all (a scan or an
 * image-only export) — there is no OCR here, and the caller is expected to tell
 * the user that rather than storing an empty document.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {Promise<string>}
 */
async function extractPdfText(buffer) {
  const pdfjs = await loadPdfjs();

  // pdfjs takes ownership of the array it is handed, so pass a copy — the caller
  // still needs the original buffer to record the file size.
  const data = new Uint8Array(buffer);

  const task = pdfjs.getDocument({
    data,
    // No scripting, no eval, no network fetches for fonts: this is untrusted
    // input from an arbitrary file the user dropped in.
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    enableXfa: false,
    standardFontDataUrl: standardFontDataUrl()
  });

  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    throw new Error('Could not read this PDF (' + (e && e.message ? e.message : String(e)) + ').');
  }

  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      try {
        const content = await page.getTextContent();
        const text = itemsToText(content.items);
        if (text.trim()) pages.push(text);
      } finally {
        page.cleanup();
      }
    }
    return pages.join('\n\n').trim();
  } finally {
    try { await doc.destroy(); } catch (_) { /* nothing useful to do */ }
  }
}

// pdfjs emits positioned text runs, not lines. `hasEOL` marks the end of a
// visual line; without honouring it every page collapses into one long smear
// and the chunker loses all paragraph structure.
function itemsToText(items) {
  let out = '';
  for (const item of items || []) {
    if (typeof item.str !== 'string') continue;
    out += item.str;
    if (item.hasEOL) out += '\n';
    else if (item.str && !/\s$/.test(item.str)) out += ' ';
  }
  return out;
}

module.exports = { extractPdfText };
