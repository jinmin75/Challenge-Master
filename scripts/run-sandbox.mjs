// Runs the installer smoke test inside a disposable Windows Sandbox, which has no Node.js or Python.
// Usage: node scripts/run-sandbox.mjs [--timeout-minutes 20]
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const project = resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).version;
const installerName = `Challenge-Master-Setup-${version}-win-x64.exe`;
const installer = join(project, 'dist', installerName);
const sandboxExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsSandbox.exe');
const timeoutFlag = process.argv.indexOf('--timeout-minutes');
const timeoutMinutes = timeoutFlag > 0 ? Number(process.argv[timeoutFlag + 1]) : 20;

function escapeXml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sandboxConfig(inputDir, outputDir) {
  // Networking is off: the app must work offline, and the sandbox needs no LAN access.
  return `<Configuration>
  <Networking>Disable</Networking>
  <MemoryInMB>4096</MemoryInMB>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>${escapeXml(inputDir)}</HostFolder>
      <SandboxFolder>C:\\cm\\in</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>${escapeXml(outputDir)}</HostFolder>
      <SandboxFolder>C:\\cm\\out</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\cm\\in\\sandbox-run.ps1</Command>
  </LogonCommand>
</Configuration>
`;
}

async function waitForResult(file, minutes) {
  const deadline = Date.now() + minutes * 60 * 1000;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      // The sandbox may still be flushing the file; retry until it parses.
      try { return JSON.parse(readFileSync(file, 'utf8')); } catch { /* keep waiting */ }
    }
    await new Promise(done => setTimeout(done, 5000));
  }
  throw new Error(`No sandbox result after ${minutes} minutes: ${file}`);
}

async function main() {
  if (!existsSync(sandboxExe)) {
    throw new Error('Windows Sandbox is not enabled. Enable "Windows Sandbox" in Windows Features, restart, and retry.');
  }
  if (!existsSync(installer)) throw new Error(`Build the installer first: ${installer}`);
  // Map a local temp copy: Sandbox maps host folders, and the project may sit on a virtual cloud drive.
  const work = mkdtempSync(join(tmpdir(), 'challenge-master-sandbox-'));
  const inputDir = join(work, 'in');
  const outputDir = join(work, 'out');
  mkdirSync(inputDir);
  mkdirSync(outputDir);
  copyFileSync(installer, join(inputDir, installerName));
  for (const script of ['smoke-installer.mjs', 'sandbox-run.ps1']) {
    copyFileSync(join(project, 'scripts', script), join(inputDir, script));
  }
  const wsb = join(work, 'challenge-master-clean.wsb');
  writeFileSync(wsb, sandboxConfig(inputDir, outputDir), 'utf8');
  console.log(`Sandbox workspace: ${work}`);
  spawn(sandboxExe, [wsb], { detached: true, stdio: 'ignore' }).unref();
  const result = await waitForResult(join(outputDir, 'result.json'), timeoutMinutes);
  console.log(JSON.stringify(result, null, 2));
  console.log(`Transcript: ${join(outputDir, 'transcript.txt')}`);
  console.log(`Files: ${readdirSync(outputDir).join(', ')}`);
  if (!result.passed) process.exitCode = 1;
}

main().catch(error => {
  console.error(`Sandbox test failed: ${error.message}`);
  process.exitCode = 1;
});
