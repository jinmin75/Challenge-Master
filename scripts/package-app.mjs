// Copies the app payload shared by the Windows installer and the macOS app bundle.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const PDFJS_VERSION = '6.3.289';
// Only what text extraction loads: the legacy build, its worker, CMaps, fonts and wasm decoders.
const PDFJS_PARTS = ['package.json', 'LICENSE', 'legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs',
  'cmaps', 'standard_fonts', 'wasm'];

function copyFile(source, target) {
  const data = readFileSync(source);
  // npm on a cloud-synced drive has left zero-byte files behind; never ship one.
  if (data.length === 0) throw new Error(`Refusing to package an empty file: ${source}`);
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, data);
}

export function copyTree(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) copyFile(from, to);
    else throw new Error(`Unsupported source entry: ${from}`);
  }
}

export function copyAppPayload(project, appDir) {
  for (const directory of ['src', 'web']) copyTree(join(project, directory), join(appDir, directory));
  copyFile(join(project, 'fixtures', 'synthetic-plan.json'), join(appDir, 'fixtures', 'synthetic-plan.json'));
  copyFile(join(project, 'package.json'), join(appDir, 'package.json'));
  const pdfjs = join(project, 'node_modules', 'pdfjs-dist');
  const installed = JSON.parse(readFileSync(join(pdfjs, 'package.json'), 'utf8')).version;
  if (installed !== PDFJS_VERSION) {
    throw new Error(`pdfjs-dist ${installed} is installed; expected ${PDFJS_VERSION} (run npm ci --omit=optional)`);
  }
  for (const part of PDFJS_PARTS) {
    const from = join(pdfjs, part);
    const to = join(appDir, 'node_modules', 'pdfjs-dist', part);
    if (statSync(from).isDirectory()) copyTree(from, to);
    else copyFile(from, to);
  }
}
