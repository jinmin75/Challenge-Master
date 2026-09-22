import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
let count = 0;
for (const folder of ['src', 'tests', 'scripts']) {
  for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
    const file = join(root, folder, entry.name);
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) { process.stderr.write(result.stderr || String(result.error)); process.exit(1); }
    const content = readFileSync(file, 'utf8');
    if (/[\t ]+$/m.test(content)) throw new Error(`Trailing whitespace: ${folder}/${entry.name}`);
    count += 1;
  }
}
console.log(`PASS: syntax and whitespace for ${count} JavaScript modules (not a full linter or typecheck).`);
