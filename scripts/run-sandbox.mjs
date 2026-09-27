// Runs the installer smoke test inside a disposable Windows Sandbox, which has no Node.js or Python.
// Usage: node scripts/run-sandbox.mjs [--timeout-minutes 20]
// Needs the Windows Sandbox CLI (wsb.exe). On build 26200 a .wsb file launched through
// WindowsSandbox.exe started a sandbox but applied neither mapped folders nor the logon command,
// so the run is driven step by step through wsb start/connect/share/exec instead.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const project = resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).version;
const installerName = `Challenge-Master-Setup-${version}-win-x64.exe`;
const installer = join(project, 'dist', installerName);
const timeoutFlag = process.argv.indexOf('--timeout-minutes');
const timeoutMinutes = timeoutFlag > 0 ? Number(process.argv[timeoutFlag + 1]) : 20;
// Networking is off: the app must work offline, and the sandbox needs no LAN access.
const sandboxConfig = '<Configuration><Networking>Disable</Networking><MemoryInMB>4096</MemoryInMB>' +
  '<ClipboardRedirection>Disable</ClipboardRedirection></Configuration>';

function wsb(args, timeoutMs = 120000) {
  const result = spawnSync('wsb.exe', [...args, '--raw'], {
    encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
  });
  if (result.error) throw new Error(`wsb ${args[0]} failed: ${result.error.message}`);
  const text = result.stdout.trim();
  try {
    return { status: result.status, json: JSON.parse(text), text };
  } catch {
    return { status: result.status, json: null, text: text || result.stderr.trim() };
  }
}

function exec(id, command, timeoutMs) {
  return wsb(['exec', '--id', id, '-r', 'ExistingLogin', '-c', command], timeoutMs);
}

async function waitForLogin(id) {
  // A headless `wsb start` has no user session; `wsb connect` opens the window that creates one.
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const probe = exec(id, 'cmd.exe /c exit 0');
    if (probe.json?.ExitCode === 0) return;
    await new Promise(done => setTimeout(done, 5000));
  }
  throw new Error('The sandbox user session did not start within 3 minutes');
}

async function main() {
  if (spawnSync('wsb.exe', ['--version'], { windowsHide: true }).status !== 0) {
    throw new Error('Windows Sandbox CLI (wsb.exe) is unavailable. Enable "Windows Sandbox" in Windows Features, restart, and retry.');
  }
  if (!existsSync(installer)) throw new Error(`Build the installer first: ${installer}`);
  // Share a local temp copy: the project may sit on a virtual cloud drive.
  const work = mkdtempSync(join(tmpdir(), 'challenge-master-sandbox-'));
  const inputDir = join(work, 'in');
  const outputDir = join(work, 'out');
  mkdirSync(inputDir);
  mkdirSync(outputDir);
  copyFileSync(installer, join(inputDir, installerName));
  for (const script of ['smoke-installer.mjs', 'smoke-app.mjs', 'sandbox-run.ps1']) {
    copyFileSync(join(project, 'scripts', script), join(inputDir, script));
  }
  console.log(`Sandbox workspace: ${work}`);

  const started = wsb(['start', '--config', sandboxConfig], 300000);
  const id = started.json?.Id;
  if (!id) throw new Error(`Could not start the sandbox: ${started.text}`);
  try {
    spawn('wsb.exe', ['connect', '--id', id], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    await waitForLogin(id);
    for (const [host, target, writable] of [[inputDir, 'C:\\cm\\in', false], [outputDir, 'C:\\cm\\out', true]]) {
      const shared = wsb(['share', '--id', id, '-f', host, '-s', target, ...(writable ? ['-w'] : [])]);
      if (shared.status !== 0) throw new Error(`Could not share ${target}: ${shared.text}`);
    }
    const run = exec(id, 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\cm\\in\\sandbox-run.ps1',
      timeoutMinutes * 60 * 1000);
    const resultFile = join(outputDir, 'result.json');
    if (!existsSync(resultFile)) {
      throw new Error(`No sandbox result (exec: ${run.text}). Transcript: ${join(outputDir, 'transcript.txt')}`);
    }
    const result = JSON.parse(readFileSync(resultFile, 'utf8'));
    console.log(JSON.stringify(result, null, 2));
    console.log(`Transcript: ${join(outputDir, 'transcript.txt')}`);
    console.log(`Files: ${readdirSync(outputDir).join(', ')}`);
    if (!result.passed) process.exitCode = 1;
  } finally {
    wsb(['stop', '--id', id]);
  }
}

main().catch(error => {
  console.error(`Sandbox test failed: ${error.message}`);
  process.exitCode = 1;
});
