// Web version (D022) in real browsers: builds the site, serves it under /Challenge-Master/ like GitHub Pages,
// and runs the student flow — calendar review, Korean PDF registration, reload, backup, two tabs, clearing,
// restoring — with records only in the browser. Usage:
//   PLAYWRIGHT_CORE=<local playwright-core> node scripts/browser-web.mjs [chrome] [webkit] [--shots DIR] [--url SITE]
// --url checks an already published site (e.g. https://jinmin75.github.io/Challenge-Master/) instead of a local build.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { tinyPdf } from '../tests/pdf-fixtures.mjs';
import { calendarFlow, loadPlaywright, offset, watchPage } from './browser-flows.mjs';

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const shots = option('--shots') ? resolve(option('--shots')) : null;
const liveUrl = option('--url');
const optionValues = new Set([option('--shots'), liveUrl]);
const engines = args.filter(arg => !arg.startsWith('--') && !optionValues.has(arg));
if (engines.length === 0) engines.push('chrome');
const PREFIX = '/Challenge-Master/';

let server = null;
let base = liveUrl;
if (!liveUrl) {
  const site = mkdtempSync(join(tmpdir(), 'challenge-web-site-'));
  const build = spawnSync(process.execPath, [join(import.meta.dirname, 'build-web.mjs'), site], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr || build.stdout);

  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
    '.wasm': 'application/wasm' };
  server = createServer((request, response) => {
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
  base = `http://127.0.0.1:${server.address().port}${PREFIX}`;
}

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
// Student records must not leave the browser: every request has to stay on the site's own origin.
const externalRequests = [];
function watchOrigin(page) {
  page.on('request', request => {
    const url = request.url();
    if (!url.startsWith('blob:') && !url.startsWith('data:') && new URL(url).origin !== new URL(base).origin) {
      externalRequests.push(url);
    }
  });
}
// Names in a zip's central directory (the export is a stored zip written by src/zip-core.mjs).
function zipNames(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  let at = view.getUint32(end + 16, true);
  const names = [];
  for (let i = 0; i < view.getUint16(end + 10, true); i += 1) {
    const length = view.getUint16(at + 28, true);
    names.push(new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + length)));
    at += 46 + length;
  }
  return names;
}
const text = (page, selector) => page.locator(selector).textContent();
const waitText = (page, selector, expected) => page.waitForFunction(([s, e]) =>
  document.querySelector(s)?.textContent.includes(e), [selector, expected]);

// The setup record's creation day, moved back so the calendar has past days (the page's own browser storage).
const moveSetupBack = (page, days) => page.evaluate(async back => {
  const db = await new Promise((done, fail) => {
    const open = indexedDB.open('challenge-master');
    open.onsuccess = () => done(open.result);
    open.onerror = () => fail(open.error);
  });
  const store = db.transaction('kv', 'readwrite').objectStore('kv');
  const setup = await new Promise(done => { const get = store.get('setup'); get.onsuccess = () => done(get.result); });
  const moved = new Date();
  moved.setDate(moved.getDate() - back);
  setup.createdAt = moved.toISOString();
  await new Promise(done => { const put = store.put(setup, 'setup'); put.onsuccess = () => done(); });
  db.close();
}, days);
const koreanDay = iso => `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8))}일`;

// 보관함 draws its lists after the tab opens; wait for them before typing into any of them.
async function openKeep(page) {
  // The mark from an earlier visit is cleared first: the tab switch itself runs a moment after the click.
  await page.evaluate(() => document.querySelector('#view-keep').removeAttribute('data-loaded'));
  await page.click('#appTabs a[href="#keep"]');
  await page.locator('#view-keep[data-loaded]').waitFor({ state: 'attached' });
}

// D024 first run: what to study (rows), how long a day (chips), and an optional PDF.
async function firstRun(page, { pdf = null, daily = '1시간' } = {}) {
  await page.locator('#firstRun:not([hidden])').waitFor();
  await page.locator('.task-title').nth(0).fill('1장 핵심 개념');
  await page.locator('.task-minutes input').nth(0).fill('40');
  await page.locator('.task-title').nth(1).fill('지난 요약');
  await page.locator('.task-minutes input').nth(1).fill('20');
  await page.locator('#dailyChips .chip', { hasText: daily }).click();
  if (pdf) await page.locator('#pdfInput').setInputFiles(pdf);
  await page.click('#setupSubmit');
  await page.locator('#todayMain:not([hidden]) #allocations .task-pick').first().waitFor();
}

async function checkEngine(name, playwright) {
  const browser = name === 'webkit'
    ? await playwright.webkit.launch()
    : await playwright.chromium.launch({ channel: 'chrome', headless: true });
  const viewport = { width: 1100, height: 1000 };
  try {
    // A. The calendar: a plan set up three days ago with no records since (the page's own module seeds the days).
    const contextA = await browser.newContext({ viewport });
    const pageA = await contextA.newPage();
    const watchA = watchPage(pageA);
    watchOrigin(pageA);
    pageA.on('dialog', dialog => dialog.accept());
    await pageA.goto(base, { waitUntil: 'networkidle' });
    // No demo plan any more: the first screen asks what to study, and only three tabs exist.
    await pageA.locator('#firstRun:not([hidden])').waitFor();
    assert.deepEqual(await pageA.locator('#appTabs a').allTextContents(), ['오늘', '문제 풀기', '보관함']);
    assert.equal(await pageA.locator('#quitButton').isHidden(), true, 'quit button is for the local app only');
    assert.equal(await pageA.locator('#calendarSide').isHidden(), true, 'no calendar before a plan exists');
    await firstRun(pageA);
    await moveSetupBack(pageA, 3);
    await callApi(pageA, '/api/start', { date: offset(-3) });
    // Opening the page again makes today's plan by itself (D024: no 「오늘 시작」).
    await pageA.reload({ waitUntil: 'networkidle' });
    await pageA.waitForFunction(today => document.querySelector(`#calendarMini [data-date="${today}"]`)?.classList.contains('state-today'), offset(0));
    assert.equal((await callApi(pageA, '/api/status')).currentPlan.date, offset(0));
    await calendarFlow(pageA, { calendarOf: date => callApi(pageA, `/api/calendar?month=${date.slice(0, 7)}`) });
    // C layout: the summary is the right column on a wide screen and follows the today screen on a phone.
    const box = selector => pageA.locator(selector).boundingBox();
    const [nowWide, sideWide] = [await box('#nowCard'), await box('#calendarSide')];
    assert.ok(sideWide.x >= nowWide.x + nowWide.width, 'summary to the right of today');
    assert.doesNotMatch(await pageA.locator('#calendarSideSummary').textContent(), /null|undefined/);
    if (shots) await pageA.locator('#calendarSide').screenshot({ path: join(shots, `${name}-cal-side.png`) });
    // Closing fades out briefly (the close runs after the animation); with reduced motion it closes at once.
    await pageA.click('#calendarOpen');
    await pageA.locator('#calendarDialog[open]').waitFor();
    await pageA.waitForFunction(() => document.querySelector('#calendarDialog').getAnimations({ subtree: true }).length === 0);
    if (shots) await pageA.screenshot({ path: join(shots, `${name}-cal-dialog.png`) });
    assert.deepEqual(await pageA.evaluate(() => {
      const dialog = document.querySelector('#calendarDialog');
      document.querySelector('#calendarClose').click();
      return [dialog.open, dialog.classList.contains('closing')];
    }), [true, true]);
    await pageA.waitForFunction(() => !document.querySelector('#calendarDialog').open);
    await pageA.emulateMedia({ reducedMotion: 'reduce' });
    await pageA.click('#calendarOpen');
    await pageA.locator('#calendarDialog[open]').waitFor();
    assert.equal(await pageA.evaluate(() => {
      document.querySelector('#calendarClose').click();
      return document.querySelector('#calendarDialog').open;
    }), false);
    await pageA.emulateMedia({ reducedMotion: 'no-preference' });
    await pageA.setViewportSize({ width: 390, height: 844 });
    const [todayNarrow, sideNarrow] = [await box('#todayMain'), await box('#calendarSide')];
    assert.ok(sideNarrow.y >= todayNarrow.y + todayNarrow.height, 'summary under the today screen on a phone');
    assert.equal(await pageA.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
    if (shots) await pageA.screenshot({ path: join(shots, `${name}-today-phone.png`), fullPage: true });
    assert.deepEqual([watchA.consoleErrors, watchA.failedRequests], [[], []]);
    await contextA.close();

    // B. A student from first run to 보관함, in a fresh browser profile.
    // Clipboard read-back for the AI copy check: Chrome needs both permissions, WebKit knows only the read one.
    const permissions = name === 'webkit' ? ['clipboard-read'] : ['clipboard-read', 'clipboard-write'];
    const context = await browser.newContext({ viewport, acceptDownloads: true, permissions });
    const page = await context.newPage();
    const watch = watchPage(page);
    watchOrigin(page);
    page.on('dialog', dialog => dialog.accept());
    // A v0.9 bookmark lands on the tab that now holds that screen.
    await page.goto(`${base}#study`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => location.hash === '#solve');
    await page.click('#appTabs a[href="#today"]');
    await firstRun(page, { daily: '2시간',
      pdf: { name: '한글-시험.pdf', mimeType: 'application/pdf', buffer: tinyPdf({ korean: true }) } });
    assert.match(await readDraft(page), /한/, 'Korean text survives in-browser extraction');
    const status0 = await callApi(page, '/api/status');
    assert.deepEqual([status0.setup.dailyMinutes, status0.setup.weeklyMinutes], [120, 840]);
    assert.deepEqual(status0.setup.source.selectedPages, [1, 2], 'blank page fields read the whole (short) PDF');
    assert.deepEqual(status0.setup.tasks.map(task => [task.title, task.minutes, task.kind]),
      [['1장 핵심 개념', 40, 'new'], ['지난 요약', 20, 'review']]);
    if (shots) await page.screenshot({ path: join(shots, `${name}-today.png`), fullPage: true });

    // 오늘: 「지금 할 것」 and three answers; another item can be chosen; skip and rest say what happened.
    assert.match(await text(page, '#nowTitle'), /^1장 핵심 개념 · \d+분$/);
    await page.locator('#allocations .task-pick', { hasText: '지난 요약' }).click();
    assert.match(await text(page, '#nowTitle'), /^지난 요약 · /);
    await page.click('#partButton');
    await page.fill('#minutesInput', '5');
    await page.locator('#partForm button[type=submit]').click();
    await waitText(page, '#todayMessage', '5분 적었어요');
    const before = await text(page, '#todayMessage');
    await page.click('#doneButton');
    await page.waitForFunction(previous => {
      const now = document.querySelector('#todayMessage').textContent;
      return now !== previous && now.includes('분 적었어요');
    }, before);
    const recorded = (await callApi(page, '/api/status')).confirmedProgressMinutes;
    assert.ok(recorded > 5);
    await page.locator('#allocations .today-item').first().getByRole('button', { name: '건너뛰기' }).waitFor();
    await page.click('#restButton');
    await waitText(page, '#nowTitle', '오늘은 쉬는 날이에요');
    await page.click('#unrestButton');
    await page.locator('#doneButton:not([hidden])').waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#todayMain:not([hidden])').waitFor();
    assert.equal((await callApi(page, '/api/status')).confirmedProgressMinutes, recorded, 'records survive a reload');
    await page.locator('#backupNotice:not([hidden])').waitFor();

    // 문제 풀기: my answer first; the button says what to do first; comparing freezes my answer.
    await page.click('#appTabs a[href="#solve"]');
    await page.locator('[data-field="question"]').waitFor();
    assert.doesNotMatch(await page.locator('#solveWork').innerText(), /null|undefined/);
    const reason = label => text(page, `[data-reason="${label}"]`);
    const action = label => page.locator(`[data-action="${label}"]`);
    assert.equal(await action('교재랑 맞춰 보기').isDisabled(), true);
    assert.equal(await reason('교재랑 맞춰 보기'), '문제를 먼저 적어 주세요.');
    await page.fill('[data-field="question"]', '형성평가를 설명하시오.');
    assert.match(await reason('교재랑 맞춰 보기'), /내 답을 먼저 써 주세요/);
    await page.fill('[data-field="firstAnswer"]', '수업 중에 하는 평가');
    // Typed but not saved: reloading asks first.
    const [unload] = await Promise.all([page.waitForEvent('dialog'), page.reload({ waitUntil: 'networkidle' })]);
    assert.equal(unload.type(), 'beforeunload');
    await page.fill('[data-field="question"]', '형성평가를 설명하시오.');
    await page.fill('[data-field="firstAnswer"]', '수업 중에 하는 평가');
    await action('교재랑 맞춰 보기').click();
    await page.locator('[data-field="revision"]').waitFor();
    // No page matched the question's words in this tiny PDF: the learner picks one under 「다른 쪽 보기」.
    await waitText(page, '[data-note="solve"]', '교재 쪽을 찾지 못했어요');
    assert.match(await text(page, '.compare-mine'), /수업 중에 하는 평가/);
    await page.locator('.other-pages button', { hasText: '1쪽 보기' }).click();
    await waitText(page, '.compare-book', '교재 1쪽');
    assert.match(await text(page, '.compare-book .page-text'), /한/);
    await page.fill('[data-field="missing"]', '학습 개선에 쓴다는 목적');
    await page.fill('[data-field="revision"]', '형성평가는 수업 중 학습을 개선하려고 하는 평가다.');
    await page.locator('.chip', { hasText: '헷갈렸어요' }).click();
    await page.locator('.chip', { hasText: '3일 뒤' }).click();
    await waitText(page, '#solveWork', '「오늘」 할 일에 들어가요');
    if (shots) await page.locator('#view-solve').screenshot({ path: join(shots, `${name}-solve.png`) });
    await action('저장').click();
    await waitText(page, '.saved-card', `${koreanDay(offset(3))}(`);
    let [problem] = await callApi(page, '/api/status').then(() => page.evaluate(async () =>
      (await import(new URL('local-api.js', location.href).href)).studySessions()));
    assert.deepEqual([problem.locked, problem.mainCause, problem.reviewDate, problem.evidence.map(ref => ref.pdfPageIndex)],
      [true, '비슷한 개념과 혼동함', offset(3), [1]]);

    // 더 보기: a memo, and the learner's own AI by copy and paste (consent first, AI answers stay estimates).
    await page.locator('.saved-card button', { hasText: '이 문제 다시 보기' }).click();
    await page.locator('.solve-more summary').click();
    assert.equal(await reason('메모 남기기'), '메모를 먼저 적어 주세요.');
    await page.fill('[data-form-field="memo"]', '형성평가: 수업 중 학습 개선');
    await action('메모 남기기').click();
    await waitText(page, '.memo-list', '형성평가: 수업 중 학습 개선');
    await page.selectOption('.ai-box select', 'Claude');
    await waitText(page, '.ai-consent', 'Claude에 붙여 넣을 내용');
    assert.match(await reason('좋아요, 요청문 만들기'), /교재 원문을 보낼지 먼저 골라 주세요/);
    await page.locator('.ai-consent .chip', { hasText: '함께 보낼게요' }).click();
    assert.match(await reason('좋아요, 요청문 만들기'), /확인란을 먼저/);
    await page.check('[data-ai-field="agree"]');
    await action('좋아요, 요청문 만들기').click();
    await waitText(page, '[data-note="solve"]', '요청문을 만들었어요');
    const request = await page.inputValue('[data-form-field="ai-request"]');
    assert.match(request, /\[학습로그 후보\]/);
    assert.match(request, /제가 찾은 빠진 것: 학습 개선에 쓴다는 목적/);
    await action('요청문 복사').click();
    await waitText(page, '[data-note="solve"]', '복사했어요');
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), request);
    await page.fill('[data-form-field="ai-response"]', ['[현재 자료에 근거한 설명] PDF 1쪽에 따르면… PDF 7쪽도 보세요.',
      '[학습로그 후보]', '- 핵심 개념 | 형성평가 | 수업 중 학습 개선을 위한 평가', '- 확인 필요 | 출처 | 교재 쪽 확인'].join('\n'));
    await action('AI 답 저장').click();
    await waitText(page, '[data-note="solve"]', '메모 2개를 제안했어요');
    assert.match(await text(page, '.ai-review summary'), /AI 의견 · 채점 아님 Claude/);
    assert.match(await text(page, '.ai-warning'), /PDF 7쪽/);
    await page.locator('.memo.candidate').first().getByRole('button', { name: '넣기' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.memo.candidate').length === 1);
    await page.locator('.memo.candidate').first().getByRole('button', { name: '빼기' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.memo.candidate').length === 0);
    await waitText(page, '.memo-list', '수업 중 학습 개선을 위한 평가');

    // 다시 풀기 starts the same question with an empty answer; 지우기 removes a problem.
    await page.locator('button', { hasText: '이 문제 다시 풀기' }).click();
    await waitText(page, '[data-note="solve"]', '같은 문제를 새로 풀어요');
    assert.equal(await page.inputValue('[data-field="question"]'), '형성평가를 설명하시오.');
    assert.equal(await page.inputValue('[data-field="firstAnswer"]'), '');
    await page.locator('button', { hasText: '이 문제 지우기' }).click();
    await waitText(page, '.solve-head', '새 문제');

    // 보관함: 다시 볼 문제 (not due yet: the button says when), 푼 문제 opens in 문제 풀기.
    await openKeep(page);
    await waitText(page, '#notesList', '지금 볼 문제가 없어요');
    await page.selectOption('#notesScope', 'all');
    await waitText(page, '#notesList', '헷갈렸어요');
    assert.equal(await page.locator('[data-action="다시 봤어요"]').isDisabled(), true);
    assert.match(await text(page, '[data-reason="다시 봤어요"]'), new RegExp(`${koreanDay(offset(3))}에 다시 볼 차례가 돼요`));
    await waitText(page, '#solvedList', '고쳐 씀 · 헷갈렸어요');
    await page.locator('#solvedList .solved-item').first().click();
    await page.waitForFunction(() => location.hash === '#solve');
    await page.locator('[data-field="revision"]').waitFor();
    // Due today: the next plan puts it in today's list within the review time; 「다시 봤어요」 records it.
    await openKeep(page);
    await page.selectOption('#notesScope', 'all');
    await page.fill('.note-date input[type=date]', offset(0));
    await page.locator('[data-action="날짜 바꾸기"]').click();
    await waitText(page, '#notesList', `${koreanDay(offset(0))}(`);
    await callApi(page, '/api/start', { date: offset(0) });
    await page.click('#appTabs a[href="#today"]');
    await waitText(page, '#allocations', '다시 볼 문제');
    await openKeep(page);
    await waitText(page, '#notesList', '「오늘」 할 일에 있어요');
    assert.equal(await page.locator('[data-action="날짜 바꾸기"]').isDisabled(), true);
    await page.locator('[data-action="다시 봤어요"]').click();
    await waitText(page, '#notesList', '다시 봤다고 적었어요');
    if (shots) await page.locator('#view-keep').screenshot({ path: join(shots, `${name}-keep.png`) });

    // 보관 파일: saved with every record kind, AI consent listed and can be taken back.
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#backupButton')]);
    const backupPath = await download.path();
    const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
    assert.equal(backup.kind, 'challenge-master-backup');
    assert.equal(backup.study.sessions.length, 1);
    assert.equal(backup.study.logs.filter(log => log.status === 'approved').length, 2, 'the memo and the kept AI memo');
    assert.equal(backup.study.aiConsents.length, 1);
    assert.equal(backup.study.sessions[0].aiReviews[0].evidenceType, 'self_reported_external_upload');
    await waitText(page, '#storageStatus', '마지막 보관');
    await page.locator('#keepMore > summary').click();
    await waitText(page, '#aiConsentList', 'Claude · 교재 원문 함께 보냄');
    await page.locator('#aiConsentList').getByRole('button', { name: '거두기' }).click();
    await waitText(page, '#aiConsentList', '거둠 ');

    // 내 교재: what was read, and another PDF can replace it without touching the plan.
    await waitText(page, '#bookStatus', '한글-시험.pdf · 2쪽을 읽었어요');
    await page.locator('#attachInput').setInputFiles({ name: '다른-교재.pdf', mimeType: 'application/pdf', buffer: tinyPdf({ korean: true }) });
    await page.locator('#attachButton').click();
    await waitText(page, '#bookStatus', '다른-교재.pdf');
    assert.equal((await callApi(page, '/api/status')).confirmedProgressMinutes, recorded + 10, 'the plan records stay');

    // 내 노트로 보내기: Moa-layout zip (and the folder writer where the browser offers it).
    await waitText(page, '#wikiSummary', '보낼 문제 1개(새로 1');
    await waitText(page, '#wikiCheck', '형식 확인: 이상 없어요');
    const [zipDownload] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="묶음 파일(zip) 받기"]')]);
    const names = zipNames(readFileSync(await zipDownload.path()));
    assert.ok(names.some(entry => /^wiki\/자료원본\/.+-[0-9a-f]{8}-[0-9a-f]{8}\.md$/.test(entry)), names.join('\n'));
    assert.ok(names.some(entry => entry.startsWith('wiki/학습로그/') && !entry.includes('_챌린지')));
    await waitText(page, '[data-note="wiki"]', '묶음 파일을 받았어요');
    const pickerSupported = await page.evaluate(() => typeof window.showDirectoryPicker === 'function');
    if (!pickerSupported) assert.match(await text(page, '[data-reason="내 노트 폴더에 바로 넣기"]'), /Chrome·Edge에서 돼요/);
    const folder = !pickerSupported ? { skipped: true } : await page.evaluate(async () => {
      const view = await import(new URL('wiki-export-view.js', location.href).href);
      const api = await import(new URL('local-api.js', location.href).href);
      const root = await navigator.storage.getDirectory();
      const refused = await view.checkWikiRoot(root);
      await root.getDirectoryHandle('wiki', { create: true });
      const accepted = await view.checkWikiRoot(root);
      const probe = await root.getFileHandle('probe.txt', { create: true });
      if (typeof probe.createWritable !== 'function') return { refused, accepted, writable: false };
      const { files } = await api.wikiExportPreview();
      const written = await view.writeFilesToDirectory(root, files);
      return { refused, accepted, writable: true, count: written.length, total: files.length };
    });
    if (!folder.skipped) {
      assert.match(folder.refused, /wiki나 raw 폴더가 없어요/);
      assert.equal(folder.accepted, null);
      if (folder.writable) assert.equal(folder.count, folder.total);
    }
    const folderWriterChecked = folder.skipped ? 'not offered (no folder picker)' : folder.writable ? 'written and read back' : 'no writable files';

    // 공부할 것 바꾸기 opens the first-run form with a way back.
    await page.click('#setupAgain');
    await waitText(page, '#firstRunTitle', '새로 무엇을 공부하나요?');
    await page.click('#setupCancel');
    await page.locator('#todayMain:not([hidden])').waitFor();

    // A second tab writes; the first tab follows without a reload.
    const second = await context.newPage();
    const watchSecond = watchPage(second);
    await second.goto(base, { waitUntil: 'networkidle' });
    await second.locator('#partButton:not([hidden])').waitFor();
    await second.click('#partButton');
    await second.fill('#minutesInput', '1');
    await second.locator('#partForm button[type=submit]').click();
    await waitText(second, '#todayMessage', '1분 적었어요');
    await page.waitForFunction(async expected => {
      const api = await import(new URL('local-api.js', location.href).href);
      return (await api.request('/api/status')).confirmedProgressMinutes === expected;
    }, recorded + 11);
    await second.close();

    // Clearing, a wrong file, and restoring the saved file.
    await openKeep(page);
    await page.locator('#keepMore').evaluate(node => { node.open = true; });
    await page.click('#clearButton');
    await page.locator('#firstRun:not([hidden])').waitFor();
    await openKeep(page);
    await page.locator('#restoreInput').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
    await waitText(page, '#errorMessage', 'Challenge Master 백업 파일이 아닙니다.');
    await page.locator('#restoreInput').setInputFiles(backupPath);
    await waitText(page, '#solvedList', '형성평가를 설명하시오');
    await page.click('#appTabs a[href="#today"]');
    await page.locator('#todayMain:not([hidden])').waitFor();

    await page.setViewportSize({ width: 390, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll on a phone');
    assert.deepEqual([watch.consoleErrors, watch.failedRequests, watchSecond.consoleErrors], [[], [], []]);
    assert.deepEqual(externalRequests, [], 'requests left the site');
    await context.close();
    return { engine: name, version: browser.version(), passed: true, externalRequests: externalRequests.length,
      folderWriter: folderWriterChecked };
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
  server?.close();
}
