// The student flow in real Chrome against an installed app: PDF upload through the form, start, record,
// calendar, quit. Node-driven installer smokes cannot catch page-script defects such as the empty-upload
// bug fixed in 0.6.1. A temporary data folder keeps real records untouched.
// Usage: PLAYWRIGHT_CORE=<local playwright-core> node scripts/browser-installed.mjs <app command> [args...]
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { children, startApp, syntheticPdf } from './smoke-app.mjs';

async function loadChromium() {
  const path = process.env.PLAYWRIGHT_CORE;
  const module = await import(path ? pathToFileURL(join(path, 'index.mjs')).href : 'playwright-core');
  return module.chromium;
}

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export async function browserCheckInstalled({ command, args, cwd, env }) {
  const chromium = await loadChromium();
  const dataRoot = mkdtempSync(join(tmpdir(), 'challenge-browser-installed-'));
  const app = startApp({ command, args, cwd, env: { ...env, CHALLENGE_MASTER_DATA_DIR: dataRoot } });
  const exited = new Promise(done => app.child.once('exit', done));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const url = await app.ready;
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    const consoleErrors = [];
    const failedRequests = [];
    page.on('console', message => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) consoleErrors.push(message.text());
    });
    page.on('pageerror', error => consoleErrors.push(error.message));
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (response.status() >= 400 && path !== '/favicon.ico') failedRequests.push(`${response.status()} ${path}`);
    });
    await page.goto(url, { waitUntil: 'networkidle' });

    await page.locator('#pdfInput').setInputFiles({ name: 'installed-browser.pdf', mimeType: 'application/pdf',
      buffer: syntheticPdf() });
    await page.fill('#titleInput', '설치본 브라우저 시험');
    await page.fill('#tasksInput', '합성 1쪽 읽기 | 30 | 새 내용');
    await page.fill('#pageStartInput', '1');
    await page.fill('#pageEndInput', '1');
    await page.getByRole('button', { name: '이 설정으로 시작' }).click();
    await page.locator('#extractionPages li', { hasText: '추출 초안' }).waitFor();

    await page.locator('#startButton').click();
    await page.locator('#allocations li').first().waitFor();
    await page.fill('#minutesInput', '5');
    await page.locator('#progressForm button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('#confirmedMinutes')?.textContent === '5분');
    const today = localDate();
    await page.waitForFunction(day => document.querySelector(`#calendarGrid .day[data-date="${day}"]`)
      ?.textContent.includes('확인 5'), today);
    assert.match(await page.locator('#monthTitle').textContent(), /월 점검 \(한 달\)/);

    await page.locator('#quitButton').click();
    await page.waitForFunction(() => document.body.textContent.includes('창을 닫아 주세요'));
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(failedRequests, []);
    await Promise.race([exited, new Promise((_, fail) => setTimeout(() => fail(new Error('App did not exit after quit')), 10000))]);
    return { browserUpload: true, recordedMinutes: 5, calendarToday: today, quitFromPage: true };
  } finally {
    await browser.close();
    for (const child of children) child.kill();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  assert.ok(command, 'Pass the installed app command');
  const result = await browserCheckInstalled({ command, args, cwd: dirname(command), env: process.env });
  console.log(JSON.stringify(result, null, 2));
}
