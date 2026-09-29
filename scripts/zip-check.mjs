// Checks how an operating system's own unzip tool extracts a Wiki-export-style zip with Korean folder and file
// names (CI: macOS ditto, which Finder's Archive Utility builds on — not Finder itself).
//   node scripts/zip-check.mjs write <out.zip>
//   node scripts/zip-check.mjs verify <extracted folder>
// Names are compared after NFC normalization; the report says whether the file system kept them decomposed (NFD).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createZip } from '../src/zip-core.mjs';

const files = [
  { path: 'wiki/자료원본/교육학 · 형성평가-1a2b3c4d-5e6f7a8b.md', content: '---\nkind: "challenge-master-source-note"\n---\n\n# 형성평가\n' },
  { path: 'wiki/학습로그/오개념 수정 기록-9f8e7d6c.md', content: '# 한글 본문\n' },
];

const [mode, target] = process.argv.slice(2);
if (mode === 'write') {
  writeFileSync(target, createZip(files));
  console.log(`wrote ${target}`);
} else if (mode === 'verify') {
  const found = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(relative(target, path).split('\\').join('/'));
    }
  })(target);
  const nfc = found.map(name => name.normalize('NFC')).sort();
  assert.deepEqual(nfc, files.map(file => file.path).sort());
  for (const file of files) {
    const onDisk = found.find(name => name.normalize('NFC') === file.path);
    assert.equal(readFileSync(join(target, onDisk), 'utf8'), file.content);
  }
  const decomposed = found.some(name => name !== name.normalize('NFC'));
  console.log(JSON.stringify({ files: found.length, names: 'match after NFC', stored: decomposed ? 'NFD' : 'NFC' }));
} else {
  throw new Error('usage: zip-check.mjs write <out.zip> | verify <folder>');
}
