// Web version (D022) in real browsers: builds the site, serves it under /Challenge-Master/ like GitHub Pages,
// and runs the student flow — calendar review, Korean PDF registration, reload, backup, two tabs, clearing,
// restoring — with records only in the browser. Usage:
//   PLAYWRIGHT_CORE=<local playwright-core> node scripts/browser-web.mjs [chrome] [webkit] [--shots DIR]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { tinyPdf } from '../tests/pdf-fixtures.mjs';
import { calendarFlow, loadPlaywright, offset, watchPage } from './browser-flows.mjs';

const args = process.argv.slice(2);
const shotsIndex = args.indexOf('--shots');
const shots = shotsIndex >= 0 ? resolve(args[shotsIndex + 1]) : null;
const engines = args.filter((arg, index) => !arg.startsWith('--') && (shotsIndex < 0 || index !== shotsIndex + 1));
if (engines.length === 0) engines.push('chrome');
const PREFIX = '/Challenge-Master/';

const site = mkdtempSync(join(tmpdir(), 'challenge-web-site-'));
const build = spawnSync(process.execPath, [join(import.meta.dirname, 'build-web.mjs'), site], { encoding: 'utf8' });
assert.equal(build.status, 0, build.stderr || build.stdout);

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.wasm': 'application/wasm' };
const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
  if (!path.startsWith(PREFIX)) { response.writeHead(404).end(); return; }
  const file = resolve(site, normalize(path.slice(PREFIX.length) || 'index.html'));
  if (file !== site && !file.startsWith(site + sep)) { response.writeHead(403).end(); return; }
  try {
    const target = statSync(file).isDirectory() ? join(file, 'index.html') : file;
    response.writeHead(200, { 'content-type': types[extname(target)] ?? 'application/octet-stream' });
    response.end(readFileSync(target));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

// The page's own module instance, as app.js uses it.
const callApi = (page, path, body = null) => page.evaluate(async ([p, b]) =>
  (await import(new URL('local-api.js', location.href).href)).request(p, b ?? undefined), [path, body]);
const readDraft = page => page.evaluate(() => new Promise((done, fail) => {
  const open = indexedDB.open('challenge-master');
  open.onerror = () => fail(open.error);
  open.onsuccess = () => {
    const get = open.result.transaction('kv').objectStore('kv').get('draft');
    get.onsuccess = () => { done(get.result?.draftMarkdown ?? null); open.result.close(); };
  };
}));
const text = (page, selector) => page.locator(selector).textContent();
const waitText = (page, selector, expected) => page.waitForFunction(([s, e]) =>
  document.querySelector(s)?.textContent.includes(e), [selector, expected]);

async function checkEngine(name, playwright) {
  const browser = name === 'webkit'
    ? await playwright.webkit.launch()
    : await playwright.chromium.launch({ channel: 'chrome', headless: true });
  const viewport = { width: 1100, height: 1000 };
  try {
    // A. Calendar review on the demo input, seeded through the page's own module.
    const contextA = await browser.newContext({ viewport });
    const pageA = await contextA.newPage();
    const watchA = watchPage(pageA);
    await pageA.goto(base, { waitUntil: 'networkidle' });
    await pageA.waitForFunction(() => !document.querySelector('#recommendation').textContent.includes('불러오는 중'));
    assert.equal(await pageA.locator('#quitButton').isHidden(), true, 'quit button is for the local app only');
    assert.equal(await pageA.locator('#dataPanel').isVisible(), true);
    await callApi(pageA, '/api/start', { date: offset(-3) });
    await callApi(pageA, '/api/start', { date: offset(0) });
    await pageA.reload({ waitUntil: 'networkidle' });
    await calendarFlow(pageA, { calendarOf: date => callApi(pageA, `/api/calendar?month=${date.slice(0, 7)}`) });
    assert.deepEqual([watchA.consoleErrors, watchA.failedRequests], [[], []]);
    await contextA.close();

    // B. Registration and record keeping in a fresh browser profile.
    const context = await browser.newContext({ viewport, acceptDownloads: true });
    const page = await context.newPage();
    const watch = watchPage(page);
    page.on('dialog', dialog => dialog.accept());
    await page.goto(base, { waitUntil: 'networkidle' });
    await waitText(page, '#sourceLabel', '합성 데모');
    await page.locator('#pdfInput').setInputFiles({ name: '한글-시험.pdf', mimeType: 'application/pdf',
      buffer: tinyPdf({ korean: true }) });
    await page.fill('#titleInput', '웹 시험');
    await page.fill('#tasksInput', '1장 핵심 개념 | 40 | 새 내용\n지난 요약 | 20 | 복습');
    await page.fill('#dailyMinutesInput', '60');
    await page.fill('#weeklyMinutesInput', '300');
    await page.fill('#pageStartInput', '1');
    await page.fill('#pageEndInput', '2');
    await page.getByRole('button', { name: '이 설정으로 시작' }).click();
    await page.locator('#extractionPages li').nth(1).waitFor();
    const pages = await page.locator('#extractionPages li').allTextContents();
    assert.match(pages[0], /추출 초안/);
    assert.match(pages[1], /글자 없음/);
    assert.match(await readDraft(page), /한/, 'Korean text survives in-browser extraction');
    assert.match(await text(page, '#sourceLabel'), /한글-시험\.pdf/);
    if (shots) await page.locator('#setupPanel').screenshot({ path: join(shots, `${name}-registered.png`) });

    await page.locator('#startButton').click();
    await page.locator('#allocations li').first().waitFor();
    await page.fill('#minutesInput', '5');
    await page.locator('#progressForm button[type=submit]').click();
    await waitText(page, '#confirmedMinutes', '5분');
    await page.reload({ waitUntil: 'networkidle' });
    await waitText(page, '#confirmedMinutes', '5분');
    assert.match(await text(page, '#sourceLabel'), /한글-시험\.pdf/, 'records survive a reload');
    await page.locator('#backupNotice:not([hidden])').waitFor();

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#backupButton')]);
    const backupPath = await download.path();
    const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
    assert.equal(backup.kind, 'challenge-master-backup');
    assert.equal(backup.setup.title, '웹 시험');
    assert.ok(backup.events.some(event => event.type === 'task_progress_recorded' && event.completedMinutes === 5));
    assert.match(backup.draft.draftMarkdown, /한/);
    await waitText(page, '#storageStatus', '마지막 백업 파일 저장');
    await page.locator('#backupNotice[hidden]').waitFor({ state: 'attached' });

    // A second tab writes; the first tab follows without a reload.
    const second = await context.newPage();
    const watchSecond = watchPage(second);
    await second.goto(base, { waitUntil: 'networkidle' });
    await waitText(second, '#confirmedMinutes', '5분');
    await second.fill('#minutesInput', '5');
    await second.locator('#progressForm button[type=submit]').click();
    await waitText(second, '#confirmedMinutes', '10분');
    await waitText(page, '#confirmedMinutes', '10분');
    await second.close();

    await page.click('#clearButton');
    await waitText(page, '#sourceLabel', '합성 데모');
    await waitText(page, '#confirmedMinutes', '0분');

    await page.locator('#restoreInput').setInputFiles({ name: 'broken.json', mimeType: 'application/json',
      buffer: Buffer.from('{}') });
    await waitText(page, '#errorMessage', 'Challenge Master 백업 파일이 아닙니다.');
    await page.locator('#restoreInput').setInputFiles(backupPath);
    await waitText(page, '#confirmedMinutes', '5분');
    assert.match(await text(page, '#sourceLabel'), /한글-시험\.pdf/, 'restored from the backup file');
    await waitText(page, '#storageStatus', '마지막 백업 파일 저장');
    if (shots) await page.locator('#dataPanel').screenshot({ path: join(shots, `${name}-data.png`) });

    await page.setViewportSize({ width: 390, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll on a phone');
    assert.deepEqual([watch.consoleErrors, watch.failedRequests, watchSecond.consoleErrors], [[], [], []]);
    await context.close();
    return { engine: name, version: browser.version(), passed: true };
  } finally {
    await browser.close();
  }
}

try {
  const playwright = await loadPlaywright();
  const results = [];
  for (const engine of engines) results.push(await checkEngine(engine, playwright));
  console.log(JSON.stringify(results, null, 2));
} finally {
  server.close();
}
