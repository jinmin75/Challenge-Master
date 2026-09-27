// Smoke test for the macOS app zip. Runs on macOS (GitHub Actions); never on a student's Mac.
// Usage: node scripts/smoke-macos.mjs dist/Challenge-Master-<version>-macos.zip
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { children, exerciseApp, json, startApp } from './smoke-app.mjs';

const zip = resolve(process.argv[2] ?? '');
const work = mkdtempSync(join(tmpdir(), 'challenge-macos-smoke-'));
const app = join(work, 'Challenge Master.app');
const launcher = join(app, 'Contents', 'MacOS', 'challenge-master');
const tempData = join(work, 'data');
const defaultData = join(homedir(), 'Library', 'Application Support', 'ChallengeMaster');
const hadDefaultData = existsSync(defaultData);

function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 120000 });
}

async function waitFor(check, what, seconds = 30) {
  for (let i = 0; i < seconds * 4; i += 1) {
    const value = await check();
    if (value) return value;
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

try {
  assert.equal(process.platform, 'darwin', 'Run this smoke test on macOS');
  assert.ok(existsSync(zip), `Missing zip: ${zip}`);
  assert.equal(run('ditto', ['-x', '-k', zip, work]).status, 0, 'ditto could not unpack the zip');
  for (const file of [launcher, join(app, 'Contents', 'Resources', 'runtime', 'node-arm64', 'node'),
    join(app, 'Contents', 'Resources', 'runtime', 'node-x64', 'node')]) {
    accessSync(file, constants.X_OK);
  }
  assert.equal(run('plutil', ['-lint', join(app, 'Contents', 'Info.plist')]).status, 0);
  const machine = run('uname', ['-m']).stdout.trim();

  // 1. Launcher in the foreground: register a PDF, record time, restart.
  const launch = () => startApp({ command: launcher, args: ['--no-browser'], cwd: work,
    env: { ...process.env, CHALLENGE_MASTER_FOREGROUND: '1', CHALLENGE_MASTER_DATA_DIR: tempData,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
  const restored = await exerciseApp(launch, tempData);

  // 2. The way a student opens it: `open` runs the launcher, which must leave the server running.
  // Uses the real per-user folder, so it refuses to run where records already exist.
  assert.ok(!hadDefaultData, `Refusing to touch existing records: ${defaultData}`);
  const opened = run('open', ['-n', app, '--args', '--no-browser']);
  assert.equal(opened.status, 0, opened.stderr);
  const instance = join(defaultData, 'instance.json');
  const url = await waitFor(() => existsSync(instance) && JSON.parse(readFileSync(instance, 'utf8')).url,
    'the server started through open');
  const status = await json(url, '/api/status');
  assert.equal(status.setup.configured, false);
  await json(url, '/api/quit', {});
  await waitFor(() => !existsSync(instance), 'the server to stop');

  // Gatekeeper verdict for the unsigned bundle, recorded for the docs; not a pass/fail condition.
  const gatekeeper = run('spctl', ['--assess', '--type', 'execute', '-vv', app]);
  console.log(JSON.stringify({ zip, machine, pdfPages: 1,
    confirmedProgressMinutes: restored.confirmedProgressMinutes, restartPersisted: true,
    launchedThroughOpen: true, defaultDataRoot: defaultData,
    gatekeeper: { exitCode: gatekeeper.status, output: `${gatekeeper.stdout}${gatekeeper.stderr}`.trim() },
  }, null, 2));
} finally {
  for (const child of children) child.kill();
  rmSync(work, { recursive: true, force: true });
  if (!hadDefaultData) rmSync(defaultData, { recursive: true, force: true });
}
