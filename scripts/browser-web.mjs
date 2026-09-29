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
    watchOrigin(pageA);
    await pageA.goto(base, { waitUntil: 'networkidle' });
    await pageA.waitForFunction(() => !document.querySelector('#recommendation').textContent.includes('불러오는 중'));
    assert.equal(await pageA.locator('#quitButton').isHidden(), true, 'quit button is for the local app only');
    assert.equal(await pageA.locator('#appTabs').isVisible(), true);
    // 교재 tab before any registration: an explanation, not an empty page.
    await pageA.click('#appTabs a[href="#source"]');
    await pageA.locator('#sourceEmpty').waitFor({ state: 'visible' });
    assert.equal(await pageA.locator('#view-plan').isHidden(), true);
    await pageA.click('#appTabs a[href="#plan"]');
    await pageA.locator('#view-plan').waitFor({ state: 'visible' });
    await callApi(pageA, '/api/start', { date: offset(-3) });
    await callApi(pageA, '/api/start', { date: offset(0) });
    await pageA.reload({ waitUntil: 'networkidle' });
    await calendarFlow(pageA, { calendarOf: date => callApi(pageA, `/api/calendar?month=${date.slice(0, 7)}`) });
    // C layout: the summary is the right column on a wide screen and follows the first panel on a phone.
    const box = selector => pageA.locator(selector).boundingBox();
    const [primaryWide, sideWide] = [await box('#view-plan .primary'), await box('#calendarSide')];
    assert.ok(sideWide.x >= primaryWide.x + primaryWide.width, 'summary to the right of the plan');
    assert.doesNotMatch(await pageA.locator('#calendarSideSummary').textContent(), /null|undefined/);
    if (shots) await pageA.locator('#calendarSide').screenshot({ path: join(shots, `${name}-cal-side.png`) });
    // Closing fades out briefly (the close runs after the animation), and opens again cleanly.
    await pageA.click('#calendarOpen');
    await pageA.locator('#calendarDialog[open]').waitFor();
    // Screenshots after the opening animation has finished.
    await pageA.waitForFunction(() => document.querySelector('#calendarDialog').getAnimations({ subtree: true }).length === 0);
    if (shots) await pageA.screenshot({ path: join(shots, `${name}-cal-dialog.png`) });
    assert.deepEqual(await pageA.evaluate(() => {
      const dialog = document.querySelector('#calendarDialog');
      document.querySelector('#calendarClose').click();
      return [dialog.open, dialog.classList.contains('closing')];
    }), [true, true]);
    await pageA.waitForFunction(() => !document.querySelector('#calendarDialog').open);
    // With reduced motion the dialog closes at once.
    await pageA.emulateMedia({ reducedMotion: 'reduce' });
    await pageA.click('#calendarOpen');
    await pageA.locator('#calendarDialog[open]').waitFor();
    assert.equal(await pageA.evaluate(() => {
      document.querySelector('#calendarClose').click();
      return document.querySelector('#calendarDialog').open;
    }), false);
    await pageA.emulateMedia({ reducedMotion: 'no-preference' });
    await pageA.setViewportSize({ width: 390, height: 844 });
    const [primaryNarrow, sideNarrow] = [await box('#view-plan .primary'), await box('#calendarSide')];
    assert.ok(sideNarrow.y >= primaryNarrow.y + primaryNarrow.height, 'summary under the first panel on a phone');
    assert.equal(await pageA.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
    if (shots) await pageA.locator('#calendarSide').screenshot({ path: join(shots, `${name}-cal-side-phone.png`) });
    await pageA.click('#calendarOpen');
    await pageA.locator('#calendarDialog[open]').waitFor();
    // Screenshots after the opening animation has finished.
    await pageA.waitForFunction(() => document.querySelector('#calendarDialog').getAnimations({ subtree: true }).length === 0);
    if (shots) await pageA.screenshot({ path: join(shots, `${name}-cal-dialog-phone.png`) });
    await pageA.keyboard.press('Escape');
    await pageA.waitForFunction(() => !document.querySelector('#calendarDialog').open);
    assert.deepEqual([watchA.consoleErrors, watchA.failedRequests], [[], []]);
    await contextA.close();

    // B. Registration and record keeping in a fresh browser profile.
    // Clipboard read-back for the B copy check: Chrome needs both permissions to write from a script-driven click,
    // WebKit writes on a click by itself and knows only the read permission.
    const permissions = name === 'webkit' ? ['clipboard-read'] : ['clipboard-read', 'clipboard-write'];
    const context = await browser.newContext({ viewport, acceptDownloads: true, permissions });
    const page = await context.newPage();
    const watch = watchPage(page);
    watchOrigin(page);
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

    // A-1 교재 보기: extracted pages, textless page, word search with highlights, and the tab survives a reload.
    await page.click('#appTabs a[href="#source"]');
    await page.locator('#sourcePageList li').nth(1).waitFor();
    assert.equal(await page.locator('#sourcePageList li').count(), 2);
    assert.match(await text(page, '#sourceTitle'), /웹 시험/);
    assert.match(await text(page, '#sourcePage .page-text'), /한/);
    await page.fill('#sourceSearch', '한');
    await waitText(page, '#sourceSearchResult', '1개 쪽에서 1곳');
    assert.equal(await page.locator('#sourcePage mark').count(), 1);
    await page.locator('#sourcePageList li').nth(1).locator('button').click();
    await waitText(page, '#sourcePage', '글자를 뽑지 못했습니다');
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#sourcePageList li').first().waitFor();
    assert.equal(await page.locator('#view-source').isVisible(), true, 'the 교재 tab stays after a reload');
    if (shots) await page.locator('#view-source').screenshot({ path: join(shots, `${name}-source.png`) });

    // A-2 학습실 (docs/moa-lessons.md #1 reasons beside disabled buttons, #2 next step works without a reload).
    await page.click('#appTabs a[href="#study"]');
    await waitText(page, '#studyList', '아직 학습 기록이 없습니다');
    // No stray "null"/"undefined" text on any view drawn so far (replaceChildren writes null as text).
    assert.doesNotMatch(await page.locator('#studyWork').innerText(), /null|undefined/);
    const reason = label => text(page, `[data-reason="${label}"]`);
    const action = label => page.locator(`[data-action="${label}"]`);
    const stepField = name => page.locator(`[data-field="${name}"]`);
    assert.equal(await action('기록 저장').isDisabled(), true);
    assert.match(await reason('기록 저장'), /잠김: 문제를 먼저 입력하세요/);
    await stepField('subject').fill('교육학');
    await stepField('goal').fill('평가 유형');
    await stepField('question').fill('형성평가를 설명하시오.');
    assert.match(await reason('기록 저장'), /첫 답안을 먼저/);
    // Unsaved text survives opening another step and coming back.
    await page.click('[data-step="2"] .step-toggle');
    await page.click('[data-step="1"] .step-toggle');
    assert.equal(await stepField('question').inputValue(), '형성평가를 설명하시오.');
    await stepField('firstAnswer').fill('수업 중에 하는 평가');
    assert.equal(await reason('기록 저장'), '');
    await action('기록 저장').click();
    await page.locator('[data-step="2"].open').waitFor();
    assert.equal(await action('원문과 대조 시작').isDisabled(), true);
    assert.match(await reason('원문과 대조 시작'), /1개 이상 고르세요/);
    const boxes = page.locator('.evidence-list input[type=checkbox]');
    assert.equal(await boxes.nth(1).isDisabled(), true, 'a textless page cannot be evidence');
    await waitText(page, '.evidence-list', '글자가 없는 쪽이라 고를 수 없습니다');
    await boxes.nth(0).check();
    await waitText(page, '[data-note="2"]', '고른 쪽 1개를 저장했습니다');
    assert.equal(await action('원문과 대조 시작').isDisabled(), false);
    await action('원문과 대조 시작').click();
    await page.locator('[data-step="3"].open .compare').waitFor();
    assert.match(await text(page, '.compare'), /수업 중에 하는 평가/);
    assert.match(await text(page, '.compare'), /한/);
    await stepField('missing').fill('학습 개선에 쓴다는 목적');
    await action('대조 내용 저장').click();
    await waitText(page, '[data-note="3"]', '저장했습니다');
    // A-4: wrapping up waits for a revised answer; logs start from step 3's fields and are grounded in the evidence.
    assert.match(await reason('학습 마무리'), /잠김: 4단에서 수정 답안을 먼저 쓰세요/);
    await page.click('[data-log-type="SUPPLEMENT"]');
    assert.equal(await page.inputValue('[data-form-field="log-content"]'), '학습 개선에 쓴다는 목적');
    await action('로그 저장').click();
    await waitText(page, '[data-note="log"]', '학습로그를 저장했습니다');
    await page.click('[data-log-type="CONCEPT"]');
    assert.match(await reason('로그 저장'), /잠김: 내용을 적어 주세요/);
    await page.fill('[data-form-field="log-content"]', '형성평가: 수업 중 학습 개선을 위한 평가');
    assert.equal(await reason('로그 저장'), '');
    await action('로그 저장').click();
    await page.waitForFunction(() => document.querySelectorAll('.log-item').length === 2);
    assert.match(await page.locator('.log-item').first().textContent(), /자료 근거 있음 · 근거 1쪽/);
    await page.locator('.log-item').first().locator('button', { hasText: '고치기' }).click();
    await page.fill('[data-form-field="log-title"]', '형성평가의 목적');
    await action('로그 저장').click();
    await waitText(page, '.log-list', '형성평가의 목적');
    await page.locator('.log-item').nth(1).locator('button', { hasText: '지우기' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.log-item').length === 1);
    await page.click('[data-step="4"] .step-toggle');
    await stepField('revision').fill('형성평가는 수업 중 학습을 개선하려고 하는 평가다.');
    await stepField('reviewDate').fill(offset(3));
    await action('저장').click();
    await waitText(page, '[data-note="4"]', '저장했습니다');
    // Wrap-up: the draft lists the logs; approving twice keeps one summary (moa-lessons #8).
    await action('학습 마무리').click();
    assert.match(await page.inputValue('[data-form-field="summary-content"]'), /학습로그:\n- 보충 필요: 형성평가의 목적/);
    await action('요약 승인').click();
    await waitText(page, '[data-note="summary"]', '요약을 승인했습니다');
    await action('다시 마무리').click();
    await page.fill('[data-form-field="summary-content"]', '형성평가는 학습 개선을 위한 평가다.');
    await action('요약 승인').click();
    await waitText(page, '.summary-card', '형성평가는 학습 개선을 위한 평가다.');
    assert.equal(await page.locator('.summary-card').count(), 1);

    // B 내 AI에게 검토받기: consent first (PRD 4), a request to copy, the pasted answer stored as an AI estimate,
    // its candidates pending until 승인 / 고쳐서 승인 / 무시; a cause answer can fill step 4 but is not saved by itself.
    await page.click('[data-step="3"] .step-toggle');
    await page.selectOption('[data-ai-field="provider"]', 'Claude');
    await waitText(page, '.ai-consent', 'Claude에 붙여 넣게 되는 것');
    assert.match(await reason('동의하고 요청문 만들기'), /잠김: 교재 원문을 보내도 되는지 고르세요/);
    await page.check('input[name="ai-rights"][value="confirmed"]');
    assert.match(await reason('동의하고 요청문 만들기'), /잠김: 확인란에 체크하세요/);
    await page.check('[data-ai-field="agree"]');
    await action('동의하고 요청문 만들기').click();
    await waitText(page, '[data-note="ai"]', '동의를 기록했습니다');
    const request = await page.inputValue('[data-form-field="ai-request"]');
    assert.match(request, /\[학습로그 후보\]/);
    assert.match(request, /제가 찾은 빠진 것: 학습 개선에 쓴다는 목적/);
    assert.match(request, /교재 원문 \(웹 시험 · PDF 1쪽/);
    await action('요청문 복사').click();
    await waitText(page, '[data-note="ai"]', '복사했습니다');
    // What lands on the clipboard is the whole request, character for character (Windows Chrome writes CRLF).
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(copied.replace(/\r\n/g, '\n'), request);
    // A refused clipboard (policy, old browser) falls back to telling the learner how to copy by hand.
    await page.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.reject(new DOMException('refused', 'NotAllowedError'));
    });
    await action('요청문 복사').click();
    await waitText(page, '[data-note="ai"]', '자동 복사가 되지 않았습니다');
    assert.equal(await page.locator('[data-note="ai"]').getAttribute('role'), 'alert');
    assert.match(await reason('AI 답 저장'), /잠김: AI의 답을 붙여 넣어 주세요/);
    await page.fill('[data-form-field="ai-response"]', ['[현재 자료에 근거한 설명] PDF 1쪽에 따르면… PDF 7쪽도 보세요.',
      '[학습로그 후보]', '- 핵심 개념 | 형성평가 | 수업 중 학습 개선을 위한 평가', '- 확인 필요 | 출처 | 교재 쪽 확인',
      '- 질문 | 피드백 시점 | 언제 피드백하나'].join('\n'));
    await action('AI 답 저장').click();
    await waitText(page, '[data-note="ai"]', '학습로그 후보 3개');
    assert.match(await text(page, '.ai-review summary'), /AI 추정 · 공식 채점 아님 내 답 검토 · Claude/);
    assert.match(await page.locator('.ai-warning').textContent(), /PDF 7쪽/);
    assert.equal(await page.locator('.candidate').count(), 3);
    if (shots) await page.locator('#view-study').screenshot({ path: join(shots, `${name}-ai-step3.png`) });
    await page.locator('.candidate').first().getByRole('button', { name: '승인', exact: true }).click();
    await waitText(page, '[data-note="log"]', '학습로그로 승인했습니다');
    await page.locator('.candidate').last().getByRole('button', { name: '무시', exact: true }).click();
    await waitText(page, '.log-section', '무시한 후보 1개');
    await page.locator('.candidate').first().getByRole('button', { name: '고쳐서 승인' }).click();
    await page.fill('[data-form-field="log-title"]', '출처 쪽 확인');
    await action('고쳐서 승인').click();
    await waitText(page, '[data-note="log"]', '고친 내용으로 승인했습니다');
    assert.equal(await page.locator('.candidate').count(), 0);
    assert.equal(await page.locator('.log-item').count(), 3);
    assert.match(await text(page, '.log-section h4'), /학습로그 \(3\)/);
    assert.match(await text(page, '.log-list'), /출처 쪽 확인[\s\S]*AI 후보에서 승인/);
    assert.doesNotMatch(await page.locator('.log-item', { hasText: '출처 쪽 확인' }).textContent(), /근거 1쪽/);
    // Another purpose needs its own consent; without the textbook-rights answer the text stays out.
    await page.selectOption('[data-ai-field="purpose"]', 'cause');
    await waitText(page, '.ai-consent', '목적: 오답 원인 분류');
    await page.check('input[name="ai-rights"][value="unknown"]');
    await page.check('[data-ai-field="agree"]');
    await action('동의하고 요청문 만들기').click();
    await waitText(page, '[data-note="ai"]', '동의를 기록했습니다');
    assert.match(await page.inputValue('[data-form-field="ai-request"]'), /교재 원문: 보내지 않음/);
    await page.fill('[data-form-field="ai-response"]', '주된 원인: 비슷한 개념과 혼동함\n함께 나타난 원인: 없음');
    await action('AI 답 저장').click();
    await waitText(page, '[data-note="ai"]', '제안된 원인은 아래');
    assert.match(await text(page, '.ai-review summary >> nth=0'), /오답 원인 분류 · Claude · \d{4}-\d{2}-\d{2} · 교재 원문 없이 요청/);
    await action('4단에 원인 넣기').click();
    await page.locator('[data-step="4"].open').waitFor();
    assert.equal(await stepField('mainCause').inputValue(), '비슷한 개념과 혼동함');
    await waitText(page, '[data-note="4"]', 'AI가 제안한 원인을 넣었습니다');
    if (shots) await page.locator('#view-study').screenshot({ path: join(shots, `${name}-ai.png`) });
    // The inserted cause is not saved yet: reloading asks first (the handler above accepts, so the reload goes on).
    const [unloadDialog] = await Promise.all([page.waitForEvent('dialog'), page.reload({ waitUntil: 'networkidle' })]);
    assert.equal(unloadDialog.type(), 'beforeunload');
    await waitText(page, '#studyList', '마무리함');
    await waitText(page, '#studyList', `복습일 ${offset(3)}`);
    await page.locator('.session-item').first().click();
    await page.click('[data-step="1"] .step-toggle');
    assert.equal(await stepField('question').getAttribute('readonly'), '', 'locked question is read-only');
    assert.equal(await stepField('firstAnswer').getAttribute('readonly'), '');
    await page.click('[data-step="4"] .step-toggle');
    await action('다시 풀기').click();
    await waitText(page, '[data-note="1"]', '같은 문제로 새 기록을 만들었습니다');
    assert.equal(await page.locator('.session-item').count(), 2);
    assert.equal(await stepField('question').inputValue(), '형성평가를 설명하시오.');
    assert.equal(await stepField('firstAnswer').inputValue(), '');
    await page.click('.study-foot .danger-link');
    await page.waitForFunction(() => document.querySelectorAll('.session-item').length === 1);
    assert.match(await text(page, '.study-head'), /새 기록/);
    if (shots) await page.locator('#view-study').screenshot({ path: join(shots, `${name}-study.png`) });

    await page.click('#appTabs a[href="#plan"]');
    await page.locator('#view-plan').waitFor({ state: 'visible' });

    await page.locator('#startButton').click();
    await page.locator('#allocations li').first().waitFor();
    await page.fill('#minutesInput', '5');
    await page.locator('#progressForm button[type=submit]').click();
    await waitText(page, '#confirmedMinutes', '5분');
    await page.reload({ waitUntil: 'networkidle' });
    await waitText(page, '#confirmedMinutes', '5분');
    assert.match(await text(page, '#sourceLabel'), /한글-시험\.pdf/, 'records survive a reload');
    await page.locator('#backupNotice:not([hidden])').waitFor();

    await page.click('#appTabs a[href="#data"]');
    await page.locator('#dataPanel').waitFor({ state: 'visible' });
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#backupButton')]);
    const backupPath = await download.path();
    const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
    assert.equal(backup.kind, 'challenge-master-backup');
    assert.equal(backup.setup.title, '웹 시험');
    assert.ok(backup.events.some(event => event.type === 'task_progress_recorded' && event.completedMinutes === 5));
    assert.match(backup.draft.draftMarkdown, /한/);
    assert.equal(backup.study.sessions.length, 1, 'study records are in the backup');
    assert.equal(backup.study.logs.length, 4, 'learning logs, AI candidates included, are in the backup');
    assert.equal(backup.study.sessions[0].summary.content, '형성평가는 학습 개선을 위한 평가다.');
    assert.equal(backup.study.sessions[0].aiReviews.length, 2);
    assert.equal(backup.study.sessions[0].aiReviews[0].evidenceType, 'self_reported_external_upload');
    assert.equal(backup.study.aiConsents.length, 2, 'consents are in the backup');
    await waitText(page, '#storageStatus', '마지막 백업 파일 저장');
    await page.locator('#backupNotice[hidden]').waitFor({ state: 'attached' });
    // B: consents are listed and revocable here; revoking says what cannot be recalled (confirm dialog).
    await waitText(page, '#aiConsentList', 'Claude · 오답 원인 분류 · 교재 원문 빼고 요청');
    await page.locator('#aiConsentList li').first().getByRole('button', { name: '철회' }).click();
    await waitText(page, '#aiConsentList', '철회 ');
    assert.equal(await page.locator('#aiConsentList button').count(), 1);

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
    await page.click('#appTabs a[href="#study"]');
    await waitText(page, '#studyList', '마무리함');
    await page.click('#appTabs a[href="#data"]');
    if (shots) await page.locator('#dataPanel').screenshot({ path: join(shots, `${name}-data.png`) });

    // A-3 오답노트: a cause puts the record in the notes; on its review date it joins today's plan within the review
    // share; while planned its date is locked (reason shown); 「복습했어요」 records its time in the plan.
    await page.click('#appTabs a[href="#study"]');
    await page.locator('.session-item').first().click();
    await page.click('[data-step="4"] .step-toggle');
    await page.selectOption('[data-field="mainCause"]', '개념을 기억하지 못함');
    await page.locator('[data-other-cause][value="문항 요구를 빠뜨림"]').check();
    await page.fill('[data-field="nextAction"]', '형성평가의 목적부터 말하기');
    await page.fill('[data-field="reviewDate"]', offset(0));
    await page.locator('[data-action="저장"]').click();
    await waitText(page, '[data-note="4"]', '저장했습니다');
    await waitText(page, '#notesTab', '오답노트 (1)');
    await page.click('#appTabs a[href="#notes"]');
    await waitText(page, '#notesList', '아직 계획에 들어가지 않음');
    assert.match(await text(page, '#notesList'), /함께 나타난 원인: 문항 요구를 빠뜨림/);
    await page.click('#appTabs a[href="#plan"]');
    await page.locator('#startButton').click();
    await waitText(page, '#allocations', '오답 복습');
    await page.click('#appTabs a[href="#notes"]');
    await waitText(page, '#notesList', '오늘 계획에 있음(기록 0/10분)');
    assert.equal(await page.locator('[data-action="복습일 저장"]').isDisabled(), true);
    assert.match(await text(page, '[data-reason="복습일 저장"]'), /잠김: 계획에 들어간 복습을 먼저 마치세요/);
    await page.locator('.note-card button.secondary', { hasText: '학습실에서 열기' }).click();
    // The study view keeps its last drawing while it reloads; wait for the lock reason of this record.
    await page.locator('[data-reason="복습일"]').waitFor();
    assert.equal(await page.locator('[data-field="reviewDate"]').getAttribute('readonly'), '');
    assert.match(await text(page, '[data-reason="복습일"]'), /계획에 들어가 있습니다/);
    await page.click('#appTabs a[href="#notes"]');
    await page.locator('[data-action="복습했어요"]').click();
    await waitText(page, '#notesList', '복습을 기록했습니다');
    await waitText(page, '#notesList', '복습을 마쳤습니다');
    await waitText(page, '#confirmedMinutes', '15분');
    await page.fill('.note-date input[type=date]', offset(7));
    await page.locator('[data-action="복습일 저장"]').click();
    await waitText(page, '#notesList', `다음 복습일을 ${offset(7)}로 정했습니다`);
    await waitText(page, '#notesList', `복습일 ${offset(7)}`);
    // Opening the tab again shows only reviews due now.
    await page.click('#appTabs a[href="#plan"]');
    await page.click('#appTabs a[href="#notes"]');
    await waitText(page, '#notesList', '지금 복습할 오답이 없습니다');
    await page.selectOption('#notesScope', 'all');
    await waitText(page, '#notesList', `복습일 ${offset(7)}`);
    assert.match(await text(page, '[data-reason="복습했어요"]'), new RegExp(`${offset(7)}에 복습할 차례가 됩니다`));
    await page.waitForFunction(() => document.querySelector('#notesTab').textContent === '오답노트');
    if (shots) await page.locator('#view-notes').screenshot({ path: join(shots, `${name}-notes.png`) });

    // A-5 개인 Wiki로 내보내기: format check, Moa-layout zip, counts after export, and the folder writer.
    await page.click('#appTabs a[href="#data"]');
    await waitText(page, '#wikiSummary', '내보낼 기록 1개(새로 1');
    await waitText(page, '#wikiCheck', '형식 검사 통과');
    const [zipDownload] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="묶음 파일(zip) 받기"]')]);
    const names = zipNames(readFileSync(await zipDownload.path()));
    assert.ok(names.some(entry => /^wiki\/자료원본\/교육학 · 평가 유형-[0-9a-f]{8}-[0-9a-f]{8}\.md$/.test(entry)), names.join('\n'));
    assert.ok(names.some(entry => entry.startsWith('wiki/학습로그/') && !entry.includes('_챌린지')));
    assert.ok(names.some(entry => /^raw\/challenge-master\/[0-9a-f-]{36}\/[0-9a-f]{64}\/ingest\.md$/.test(entry)));
    await waitText(page, '[data-note="wiki"]', '묶음 파일을 받았습니다');
    await waitText(page, '#wikiSummary', '그대로 1');
    const pickerSupported = await page.evaluate(() => typeof window.showDirectoryPicker === 'function');
    if (!pickerSupported) {
      assert.match(await text(page, '[data-reason="내 Wiki 폴더에 바로 쓰기"]'), /Chrome·Edge에서 가능/);
    }
    // The picker itself is a browser dialog; the writer is checked on the browser's private folder (same handle API).
    // Only where the feature is offered (Chrome·Edge); Safari/WebKit shows the reason checked above instead.
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
      const notePath = written.find(path => path.startsWith('wiki/자료원본/') && !path.includes('_챌린지'));
      let dir = root;
      const parts = notePath.split('/');
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      const content = await (await (await dir.getFileHandle(parts.at(-1))).getFile()).text();
      return { refused, accepted, writable: true, count: written.length, total: files.length, head: content.slice(0, 50) };
    });
    if (!folder.skipped) {
      assert.match(folder.refused, /wiki나 raw 폴더가 없습니다/);
      assert.equal(folder.accepted, null);
    }
    const folderWriterChecked = folder.skipped ? 'not offered (no folder picker)' : folder.writable ? 'written and read back' : 'no writable files';
    if (folder.writable) {
      assert.equal(folder.count, folder.total);
      assert.match(folder.head, /^---\nkind: "challenge-master-source-note"/);
    }
    if (shots) await page.locator('#wikiPanel').screenshot({ path: join(shots, `${name}-wiki.png`) });

    // Registering the PDF again gives the textbook a new id: evidence chosen before (not yet compared) is named in
    // step 2 and dropped in one step, then comparison starts with pages of the new registration.
    await page.click('#appTabs a[href="#study"]');
    await page.locator('#studyNew').click();
    await stepField('question').fill('총괄평가를 설명하시오.');
    await stepField('firstAnswer').fill('학기 말 시험');
    await action('기록 저장').click();
    await page.locator('[data-step="2"].open').waitFor();
    await page.locator('.evidence-list input[type=checkbox]').nth(0).check();
    await waitText(page, '[data-note="2"]', '고른 쪽 1개를 저장했습니다');
    await page.click('#appTabs a[href="#plan"]');
    await page.locator('#pdfInput').setInputFiles({ name: '한글-시험.pdf', mimeType: 'application/pdf', buffer: tinyPdf({ korean: true }) });
    await page.fill('#pageStartInput', '1');
    await page.fill('#pageEndInput', '2');
    await page.getByRole('button', { name: '이 설정으로 시작' }).click();
    await page.locator('#extractionPages li').nth(1).waitFor();
    await page.click('#appTabs a[href="#study"]');
    await page.locator('.session-item', { hasText: '총괄평가를 설명하시오' }).click();
    // Step 2 may still be open from before the registration; open it only when closed.
    if (await page.locator('[data-step="2"].open').count() === 0) await page.click('[data-step="2"] .step-toggle');
    await waitText(page, '.stale-evidence', '지금 교재에 없는 근거 1개: PDF 1쪽');
    assert.match(await reason('원문과 대조 시작'), /잠김: 지금 교재에 없는 근거가 있습니다/);
    await action('지금 교재에 없는 근거 빼기').click();
    await waitText(page, '[data-note="2"]', '지금 교재에 없는 근거를 뺐습니다');
    assert.equal(await page.locator('.stale-evidence').count(), 0);
    await page.locator('.evidence-list input[type=checkbox]').nth(0).check();
    await waitText(page, '[data-note="2"]', '고른 쪽 1개를 저장했습니다');
    await action('원문과 대조 시작').click();
    await page.locator('[data-step="3"].open .compare').waitFor();

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
