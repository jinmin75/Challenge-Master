// Child process entry: extract selected PDF pages locally with pdf.js.
// Usage: node --max-old-space-size=512 src/pdf-extract.mjs FILE.pdf PAGES_JSON
// Stdout is one JSON document; no network access and no writes to the source.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pdfjsDirectory } from './pdfjs-path.mjs';
import { readPdfPages } from './pdf-read.mjs';

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

async function main() {
  if (process.argv.length !== 4) fail('usage: pdf-extract.mjs FILE.pdf PAGES_JSON');
  let pages;
  try { pages = JSON.parse(process.argv[3]); } catch { fail('pages must be an integer array'); }
  const dir = pdfjsDirectory();
  const pdfjs = await import(pathToFileURL(join(dir, 'legacy', 'build', 'pdf.mjs')).href);
  const result = await readPdfPages(pdfjs, {
    data: new Uint8Array(readFileSync(process.argv[2])), pages,
    cMapUrl: `${join(dir, 'cmaps')}/`,
    standardFontDataUrl: `${join(dir, 'standard_fonts')}/`,
    wasmUrl: `${join(dir, 'wasm')}/`,
  });
  process.stdout.write(JSON.stringify(result));
}

main().catch(error => fail(String(error?.message ?? error).slice(0, 300)));
