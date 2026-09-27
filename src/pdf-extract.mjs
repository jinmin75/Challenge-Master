// Child process entry: extract selected PDF pages locally with pdf.js.
// Usage: node --max-old-space-size=512 src/pdf-extract.mjs FILE.pdf PAGES_JSON
// Stdout is one JSON document; no network access and no writes to the source.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pdfjsDirectory } from './pdfjs-path.mjs';

const MAX_CONTENT_CHARS = 5_000_000;

// pdf.js reports through console; keep stdout reserved for the JSON result.
console.log = (...args) => process.stderr.write(`${args.join(' ')}\n`);
console.info = console.log;
// Rendering needs @napi-rs/canvas, which is deliberately not installed; text extraction does not.
const renderingOnly = /@napi-rs\/canvas|Require stack|pdfjs-dist|Cannot polyfill `(DOMMatrix|Path2D)`/;
const warn = console.warn;
console.warn = (...args) => { if (!renderingOnly.test(args.join(' '))) warn(...args); };

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parsePages(value, total) {
  let pages;
  try { pages = JSON.parse(value); } catch { fail('pages must be an integer array'); }
  if (!Array.isArray(pages) || !pages.every(Number.isInteger)) fail('pages must be an integer array');
  const sorted = [...pages].sort((a, b) => a - b);
  if (pages.length === 0 || new Set(pages).size !== pages.length ||
      sorted.some((page, index) => page !== pages[index])) {
    fail('pages must be nonempty, unique, and sorted');
  }
  if (pages.some(page => page < 1 || page > total)) fail('page outside PDF');
  return pages;
}

function pageText(content) {
  let text = '';
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;
    text += item.str + (item.hasEOL ? '\n' : '');
    if (text.length > MAX_CONTENT_CHARS) throw new Error('page text exceeds 5,000,000 characters');
  }
  return text;
}

async function main() {
  if (process.argv.length !== 4) fail('usage: pdf-extract.mjs FILE.pdf PAGES_JSON');
  const dir = pdfjsDirectory();
  const { getDocument, OPS, PasswordException } =
    await import(pathToFileURL(join(dir, 'legacy', 'build', 'pdf.mjs')).href);
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject,
    OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObject].filter(Number.isInteger));
  let task;
  let doc;
  try {
    task = getDocument({
      data: new Uint8Array(readFileSync(process.argv[2])),
      // Korean PDFs often rely on predefined CMaps; without them text comes out empty.
      cMapUrl: `${join(dir, 'cmaps')}/`, cMapPacked: true,
      standardFontDataUrl: `${join(dir, 'standard_fonts')}/`,
      wasmUrl: `${join(dir, 'wasm')}/`,
      useSystemFonts: false, disableFontFace: true, verbosity: 0,
    });
    doc = await task.promise;
  } catch (error) {
    if (error instanceof PasswordException || error?.name === 'PasswordException') {
      fail('encrypted PDF is not supported');
    }
    fail(`cannot open PDF: ${String(error?.message ?? error).slice(0, 300)}`);
  }
  // Match the previous extractor: any encryption, even owner-only, is refused.
  if ((await doc.getMetadata()).info?.EncryptFilterName) fail('encrypted PDF is not supported');
  const pages = parsePages(process.argv[3], doc.numPages);
  const labels = await doc.getPageLabels();
  const results = [];
  for (const number of pages) {
    let text = '';
    let imageCount = 0;
    let error = null;
    try {
      const page = await doc.getPage(number);
      text = pageText(await page.getTextContent());
      try {
        const operators = await page.getOperatorList();
        imageCount = operators.fnArray.filter(op => imageOps.has(op)).length;
      } catch (imageError) {
        error = `image inspection failed: ${imageError?.message ?? imageError}`.slice(0, 300);
      }
    } catch (pageError) {
      error = String(pageError?.message ?? pageError).slice(0, 300);
    }
    const label = labels?.[number - 1];
    results.push({ pdfPageIndex: number, printedPageLabel: label ? String(label) : 'unknown',
      text, imageCount, error });
  }
  const totalPages = doc.numPages;
  await task.destroy();
  process.stdout.write(JSON.stringify({ totalPages, pages: results }));
}

main().catch(error => fail(String(error?.message ?? error).slice(0, 300)));
