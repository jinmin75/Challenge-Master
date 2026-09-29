// Captures the screens of the one-page student guide (D024): first run, 오늘, 문제 풀기 and 보관함. Everything is
// synthetic: a generated textbook PDF (two text pages on assessment types + one picture-only page) and records dated
// relative to the capture day (the setup day is moved two days back in the browser's own storage). It also checks in
// a real browser that 「교재랑 맞춰 보기」 finds the textbook page from the question's words.
// Usage: PLAYWRIGHT_CORE=<local playwright-core> node shots-guide.mjs <repository path>
// Pictures go to ../shots/ (move the ones the guide uses to ../img/).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const project = resolve(process.argv[2]);
const guide = join(import.meta.dirname, '..');
const shots = join(guide, 'shots');
mkdirSync(shots, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_CORE
  ? pathToFileURL(join(process.env.PLAYWRIGHT_CORE, 'index.mjs')).href : 'playwright-core');
const { localDate } = await import(pathToFileURL(join(project, 'src', 'app-core.mjs')).href);
const offset = days => { const date = new Date(); date.setDate(date.getDate() + days); return localDate(date); };

// ---- a synthetic textbook ----
const work = mkdtempSync(join(tmpdir(), 'cm-guide-v09-'));
const samplePdf = join(work, '합성-교육평가.pdf');
const bookPages = [
  ['4장 교육평가의 유형 (합성 예시 자료)', [
    '형성평가는 교수·학습이 진행되는 도중에 학생의 학습 진전 상황을 확인하여 교수 방법과 학습 활동을 개선하려는 목적으로 실시한다.',
    '형성평가의 결과는 성적 산출보다 피드백 제공에 주로 쓰인다. 교사가 만든 간단한 문항이나 관찰, 질문으로도 실시할 수 있다.',
    '형성평가는 준거지향평가의 성격을 띠며, 학생이 도달해야 할 목표에 비추어 결과를 해석한다.']],
  ['4장 교육평가의 유형 (계속)', [
    '총괄평가는 일정 기간의 교수·학습이 끝난 뒤 목표 달성 정도를 종합적으로 판정하는 평가이다.',
    '총괄평가의 결과는 성적 부여와 자격 판정, 다음 교육과정의 배치 결정 등에 활용된다.',
    '진단평가는 수업 전에 출발점 행동과 선수학습 결손을 확인하는 평가이다.']],
];
const bookHtml = `<!doctype html><meta charset="utf-8"><style>
  @page { size: A4; margin: 24mm; } body { font-family: "Malgun Gothic", sans-serif; font-size: 12pt; line-height: 1.8; }
  section { page-break-after: always; } h1 { font-size: 16pt; }</style>
  ${bookPages.map(([title, lines]) => `<section><h1>${title}</h1>${lines.map(line => `<p>${line}</p>`).join('')}</section>`).join('')}
  <section><svg width="600" height="400" viewBox="0 0 600 400"><rect x="40" y="40" width="520" height="320" fill="#eef3f0" stroke="#27615a"/>
  <circle cx="200" cy="200" r="90" fill="#cfe7dd"/><circle cx="380" cy="200" r="90" fill="#fdebc8" fill-opacity="0.8"/></svg></section>`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
{
  const page = await browser.newPage();
  await page.setContent(bookHtml);
  await page.pdf({ path: samplePdf, format: 'A4' });
  await page.close();
}

// ---- the site, built and served like GitHub Pages ----
const site = join(work, 'site');
const build = spawnSync(process.execPath, [join(project, 'scripts', 'build-web.mjs'), site], { encoding: 'utf8' });
if (build.status !== 0) throw new Error(build.stderr || build.stdout);
const PREFIX = '/Challenge-Master/';
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

const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2, locale: 'ko-KR',
  acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
page.on('dialog', dialog => dialog.accept());
const shot = async (selector, name) => {
  await page.mouse.move(0, 0); // no hover colour in the picture
  await page.locator(selector).first().screenshot({ path: join(shots, `${name}.png`) });
};
// The panel around an element (its nearest section, header or .panel), for pictures of one card.
const card = async (selector, name) => {
  await page.mouse.move(0, 0);
  await page.locator(selector).first()
    .locator('xpath=ancestor-or-self::*[self::section or self::header or contains(concat(" ", normalize-space(@class), " "), " panel ")][1]')
    .screenshot({ path: join(shots, `${name}.png`) });
};
const callApi = (path, body = null) => page.evaluate(async ([p, b]) =>
  (await import(new URL('local-api.js', location.href).href)).request(p, b ?? undefined), [path, body]);
const settle = () => page.waitForFunction(() => !document.querySelector('#calendarDialog')?.getAnimations({ subtree: true }).length);

// ---- 처음 설정 (with the textbook), then a plan set up two days ago with one day left unanswered ----
await page.goto(base, { waitUntil: 'networkidle' });
await page.locator('#firstRun:not([hidden])').waitFor();
await page.locator('.task-title').nth(0).fill('4장 교육평가 유형');
await page.locator('.task-minutes input').nth(0).fill('120');
await page.locator('.task-title').nth(1).fill('3장 요약 다시 보기');
await page.locator('.task-minutes input').nth(1).fill('60');
await page.locator('#pdfInput').setInputFiles(samplePdf);
await shot('#firstRun', 'e-first');
await page.click('#setupSubmit');
await page.locator('#todayMain:not([hidden]) #allocations .task-pick').first().waitFor();
await page.evaluate(async days => {
  const db = await new Promise((done, fail) => {
    const open = indexedDB.open('challenge-master');
    open.onsuccess = () => done(open.result);
    open.onerror = () => fail(open.error);
  });
  const store = db.transaction('kv', 'readwrite').objectStore('kv');
  const setup = await new Promise(done => { const get = store.get('setup'); get.onsuccess = () => done(get.result); });
  const moved = new Date();
  moved.setDate(moved.getDate() - days);
  setup.createdAt = moved.toISOString();
  await new Promise(done => { const put = store.put(setup, 'setup'); put.onsuccess = () => done(); });
  db.close();
}, 2);
await callApi('/api/start', { date: offset(-2) });
const firstAllocation = (await callApi('/api/status')).currentPlan.allocations[0];
await callApi('/api/progress', { taskId: firstAllocation.taskId, completedMinutes: Math.min(30, firstAllocation.minutes) });
await page.reload({ waitUntil: 'networkidle' });
await page.locator('#pastAsk:not([hidden])').waitFor();
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: join(shots, 'e-today.png') });

// ---- 문제 풀기: the question's words find the textbook page by themselves ----
await page.click('#appTabs a[href="#solve"]');
await page.locator('[data-field="question"]').fill('형성평가의 목적과 결과 활용 방식을 총괄평가와 비교하여 설명하시오.');
await page.locator('[data-field="firstAnswer"]').fill('형성평가는 학기 중간에 보는 시험으로, 중간 성적을 매겨 서열화하는 데 쓴다. 총괄평가는 학기 말에 본다.');
await page.click('[data-action="교재랑 맞춰 보기"]');
await page.locator('.compare-book .page-text').waitFor();
const found = await page.locator('.page-tabs button').allTextContents();
if (!found.some(label => label.includes('1쪽'))) throw new Error(`automatic pages missed page 1: ${found.join(', ')}`);
await page.locator('[data-field="missing"]').fill('목적은 수업 개선과 피드백. 성적·서열화용이 아니다.');
await page.locator('[data-field="revision"]').fill('형성평가는 수업 도중 학습 진전을 확인해 수업과 학습을 개선하려는 평가로, 결과는 주로 피드백에 쓴다. 총괄평가는 수업이 끝난 뒤 목표 달성을 종합 판정하고 성적·자격·배치에 쓴다.');
await page.locator('.chip', { hasText: '헷갈렸어요' }).click();
await page.locator('.chip', { hasText: '3일 뒤' }).click();
await page.evaluate(() => window.scrollTo(0, 0));
await shot('#solveWork', 'e-solve');
await page.click('[data-action="저장"]');
await page.locator('.saved-card').waitFor();

// ---- 보관함 ----
await page.click('#appTabs a[href="#keep"]');
await page.locator('#view-keep[data-loaded]').waitFor({ state: 'attached' });
await page.selectOption('#notesScope', 'all');
await shot('#view-keep', 'e-keep');

await browser.close();
server.close();
console.log('done', offset(0), 'pages found:', found.join(', '));
