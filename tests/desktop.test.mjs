import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function launch(dataRoot) {
  const child = spawn(process.execPath, ['src/desktop.mjs', '--no-browser'], {
    cwd: root,
    env: { ...process.env, CHALLENGE_MASTER_DATA_DIR: dataRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    let output = '';
    let errors = '';
    const timer = setTimeout(() => rejectReady(new Error(`desktop startup timed out: ${errors}`)), 10000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/Challenge Master: (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) {
        clearTimeout(timer);
        resolveReady(match[1]);
      }
    });
    child.stderr.on('data', chunk => { errors += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); rejectReady(error); });
    child.once('exit', code => {
      if (!output.includes('Challenge Master:')) {
        clearTimeout(timer);
        rejectReady(new Error(`desktop exited ${code}: ${errors}`));
      }
    });
  });
  return { child, ready };
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await once(child, 'exit');
}

test('desktop launcher uses a private data folder and reuses an active local server', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'challenge-desktop-'));
  const first = launch(dataRoot);
  try {
    const url = await first.ready;
    const response = await fetch(`${url}api/status`);
    assert.equal(response.status, 200);
    const stored = JSON.parse(readFileSync(join(dataRoot, 'instance.json'), 'utf8'));
    assert.equal(stored.url, url);

    const second = launch(dataRoot);
    const reused = await second.ready;
    assert.equal(reused, url);
    await waitForExit(second.child);
  } finally {
    first.child.kill();
    await waitForExit(first.child).catch(() => {});
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
