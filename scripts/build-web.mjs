// Builds the static web version (D022) for GitHub Pages: page files, the shared rule modules, pdf.js and the
// demo input. Usage: node scripts/build-web.mjs [output directory, default dist/web]
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const project = resolve(import.meta.dirname, '..');
const out = resolve(process.argv[2] ?? join(project, 'dist', 'web'));
const version = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).version;
const pdfjs = join(project, 'node_modules', 'pdfjs-dist');
const pdfjsVersion = JSON.parse(readFileSync(join(pdfjs, 'package.json'), 'utf8')).version;

const pageFiles = ['app.js', 'calendar.js', 'local-api.js', 'styles.css'];
// Rule modules the page imports; each must run without Node APIs.
const sharedModules = ['app-core.mjs', 'calendar.mjs', 'events.mjs', 'ingest.mjs', 'pdf-core.mjs', 'pdf-read.mjs',
  'replan.mjs', 'scheduler.mjs', 'weekly.mjs'];

// Only this site's files; pdf.js runs its worker and optional WebAssembly decoders from the same origin.
const csp = ["default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "connect-src 'self'", "worker-src 'self' blob:", "font-src 'self' data:",
  "object-src 'none'", "base-uri 'self'", "form-action 'none'"].join('; ');

// A recursive fs copy exits Node 25 silently (code 127) on the Google Drive folder; copy file by file.
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyTree(join(from, entry.name), join(to, entry.name));
    else copyFileSync(join(from, entry.name), join(to, entry.name));
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'src'), { recursive: true });

let html = readFileSync(join(project, 'web', 'index.html'), 'utf8');
assert.ok(html.includes('<html lang="ko">'), 'index.html root element changed');
html = html.replace('<html lang="ko">', `<html lang="ko" data-mode="browser" data-version="${version}">`)
  .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`);
writeFileSync(join(out, 'index.html'), html);
for (const file of pageFiles) copyFileSync(join(project, 'web', file), join(out, file));

for (const file of sharedModules) {
  const source = readFileSync(join(project, 'src', file), 'utf8');
  assert.ok(!/from ['"]node:/.test(source), `${file} imports a Node module and cannot run in the browser`);
  writeFileSync(join(out, 'src', file), source);
}

const vendor = join(out, 'vendor', 'pdfjs');
mkdirSync(vendor, { recursive: true });
copyFileSync(join(pdfjs, 'legacy', 'build', 'pdf.min.mjs'), join(vendor, 'pdf.min.mjs'));
copyFileSync(join(pdfjs, 'legacy', 'build', 'pdf.worker.min.mjs'), join(vendor, 'pdf.worker.min.mjs'));
for (const folder of ['cmaps', 'standard_fonts', 'wasm']) copyTree(join(pdfjs, folder), join(vendor, folder));
copyFileSync(join(pdfjs, 'LICENSE'), join(vendor, 'LICENSE'));

mkdirSync(join(out, 'fixtures'), { recursive: true });
copyFileSync(join(project, 'fixtures', 'synthetic-plan.json'), join(out, 'fixtures', 'synthetic-plan.json'));
// Serve files as they are (no Jekyll processing on GitHub Pages).
writeFileSync(join(out, '.nojekyll'), '');

// npm on the synced Drive folder has written empty files before; never publish one.
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else files.push(path);
  }
})(out);
const empty = files.filter(path => statSync(path).size === 0 && !path.endsWith('.nojekyll'));
assert.deepEqual(empty, [], 'Refusing to publish empty files');
const bytes = files.reduce((sum, path) => sum + statSync(path).size, 0);
console.log(JSON.stringify({ out, version, pdfjs: pdfjsVersion, files: files.length, bytes }, null, 2));
