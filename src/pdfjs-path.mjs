import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// pdf.js lives in the app's node_modules both in development and in the packaged apps.
// CHALLENGE_MASTER_PDFJS_DIR overrides it, e.g. when node_modules cannot sit on a cloud-synced drive.
export function pdfjsDirectory() {
  const candidates = [
    process.env.CHALLENGE_MASTER_PDFJS_DIR,
    resolve(import.meta.dirname, '..', 'node_modules', 'pdfjs-dist'),
  ].filter(Boolean);
  for (const dir of candidates) {
    const entry = join(dir, 'legacy', 'build', 'pdf.mjs');
    // An empty entry file means a broken copy; refuse it rather than fail obscurely later.
    if (existsSync(entry) && statSync(entry).size > 0) return resolve(dir);
  }
  throw new Error('pdf.js (pdfjs-dist) is missing; run npm ci --omit=optional');
}
