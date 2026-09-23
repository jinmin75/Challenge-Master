import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { startServer } from './web.mjs';

const installRoot = resolve(import.meta.dirname, '../..');
const dataRoot = resolve(process.env.CHALLENGE_MASTER_DATA_DIR ??
  join(process.env.LOCALAPPDATA ?? process.env.HOME ?? installRoot, 'ChallengeMaster'));
const instanceFile = join(dataRoot, 'instance.json');
const noBrowser = process.argv.includes('--no-browser');

function validLocalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
      /^\d+$/.test(url.port) && !url.username && !url.password &&
      url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}

async function existingInstance() {
  if (!existsSync(instanceFile)) return null;
  try {
    const file = readFileSync(instanceFile, 'utf8');
    if (Buffer.byteLength(file) > 4096) return null;
    const instance = JSON.parse(file);
    if (!validLocalUrl(instance.url) || typeof instance.id !== 'string') return null;
    const response = await fetch(new URL('/api/status', instance.url), { signal: AbortSignal.timeout(1500) });
    return response.ok ? instance.url : null;
  } catch {
    return null;
  }
}

function openBrowser(url) {
  if (noBrowser) return;
  execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url],
    { windowsHide: true }, error => {
      if (error) console.error(`브라우저를 열지 못했습니다: ${error.message}`);
    });
}

async function run() {
  mkdirSync(dataRoot, { recursive: true });
  process.env.CHALLENGE_MASTER_DATA_DIR = dataRoot;
  const bundledPython = join(installRoot, 'runtime', 'python', 'python.exe');
  if (existsSync(bundledPython)) process.env.CHALLENGE_MASTER_PYTHON = bundledPython;

  const active = await existingInstance();
  if (active) {
    console.log(`Challenge Master: ${active}`);
    openBrowser(active);
    return;
  }

  const { server, url } = await startServer({ port: 0, host: '127.0.0.1' });
  const address = new URL('/', url).href;
  const id = randomUUID();
  let claimed = false;
  for (let attempt = 0; attempt < 2 && !claimed; attempt += 1) {
    try {
      writeFileSync(instanceFile, JSON.stringify({ id, url: address }), { encoding: 'utf8', flag: 'wx' });
      claimed = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const competing = await existingInstance();
      if (competing) {
        server.close();
        console.log(`Challenge Master: ${competing}`);
        openBrowser(competing);
        return;
      }
      rmSync(instanceFile);
    }
  }
  if (!claimed) {
    server.close();
    throw new Error('로컬 실행 잠금을 만들지 못했습니다.');
  }

  server.on('close', () => {
    try {
      if (JSON.parse(readFileSync(instanceFile, 'utf8')).id === id) rmSync(instanceFile);
    } catch { /* A later launch may have replaced the stale file. */ }
  });
  process.on('SIGINT', () => server.close());
  process.on('SIGTERM', () => server.close());
  console.log(`Challenge Master: ${address}`);
  openBrowser(address);
}

run().catch(error => {
  try {
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(join(dataRoot, 'startup-error.log'), `${new Date().toISOString()} ${error.message}\n`,
      { encoding: 'utf8', flag: 'a' });
  } catch { /* Preserve the original error on stderr. */ }
  console.error(`시작 오류: ${error.message}`);
  process.exitCode = 1;
});
