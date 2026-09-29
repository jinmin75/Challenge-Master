// Captures the web-version 0.9 screens for the student guide: plan with the calendar summary and dialog, 교재,
// 학습실 (four steps, learning logs, wrap-up, the learner's own AI), 오답노트 and 내 기록. Everything is synthetic:
// a generated textbook PDF (two text pages on assessment types + one picture-only page), records dated relative to
// the capture day, and an example AI answer. The registration time is moved five days back in the browser's own
// storage so the calendar has past days to check.
// Usage: PLAYWRIGHT_CORE=<local playwright-core> node shots-v09.mjs <repository path>
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

// ---- plan: registration ----
await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !document.querySelector('#recommendation').textContent.includes('불러오는 중'));
await shot('#appTabs', 'g-tabs');
await card('#startButton', 'w1-top-demo');
await page.locator('#pdfInput').setInputFiles(samplePdf);
await page.fill('#titleInput', '교육학 1회독');
await page.fill('#tasksInput', '4장 교육평가 유형 | 120 | 새 내용\n3장 요약 다시 보기 | 60 | 복습');
await page.fill('#dailyMinutesInput', '60');
await page.fill('#weeklyMinutesInput', '300');
await page.fill('#pageStartInput', '1');
await page.fill('#pageEndInput', '3');
await shot('#setupForm', 'w2-form');
await page.getByRole('button', { name: '이 설정으로 시작' }).click();
await page.locator('#extractionPages li').nth(2).waitFor();
await shot('#extractionPanel', 'w3-extraction');

// Registration five days ago, then: studied 5 and 4 days ago, a rest day 3 days ago, nothing 2 and 1 days ago.
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
  setup.source.uploadedAt = moved.toISOString();
  await new Promise(done => { const put = store.put(setup, 'setup'); put.onsuccess = () => done(); });
  db.close();
}, 5);
// Records part of the day's first allocation (never more than was assigned).
const studyFirst = async minutes => {
  const allocation = (await callApi('/api/status')).currentPlan.allocations[0];
  await callApi('/api/progress', { taskId: allocation.taskId, completedMinutes: Math.min(minutes, allocation.minutes) });
};
await callApi('/api/start', { date: offset(-5) });
await studyFirst(30);
await callApi('/api/start', { date: offset(-4) });
await studyFirst(20);
await callApi('/api/day-review', { date: offset(-3), status: 'rest' });
await page.reload({ waitUntil: 'networkidle' });
await page.locator('#startButton').click();
await page.locator('#allocations li').first().waitFor();
await card('#startButton', 'w4-top-started');
await card('#allocations', 'w4-today');
await shot('#shortenForm', 'w4-shorten');
await card('#restButton', 'w4-rest');
// Today's example goes to the largest allocation, so the picture shows an ordinary 20-minute record.
const biggest = (await callApi('/api/status')).currentPlan.allocations.reduce((a, b) => (b.minutes > a.minutes ? b : a));
const todayMinutes = Math.min(20, biggest.minutes);
const confirmedBefore = parseInt(await page.textContent('#confirmedMinutes'), 10);
await page.selectOption('#taskSelect', biggest.taskId);
await page.fill('#minutesInput', String(todayMinutes));
await shot('#progressForm', 'w4-record');
await page.getByRole('button', { name: '기록', exact: true }).click();
// 「확인된 공부」 counts every recorded minute so far, so wait for it to grow by today's minutes.
await page.waitForFunction(total => document.querySelector('#confirmedMinutes').textContent === `${total}분`,
  confirmedBefore + todayMinutes);
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: join(shots, 'g-plan-wide.png') });
await shot('#progressForm', 'g-record');
await shot('#allocations', 'g-today');
await card('#confirmedMinutes', 'w5-status');
await card('#weekAllocations', 'w5-week');
await card('#startButton', 'w6-top-backup-notice');
await shot('#calendarSide', 'g-cal-side');

// ---- calendar dialog ----
await page.setViewportSize({ width: 1100, height: 1500 });
await page.click('#calendarOpen');
await page.locator('#calendarDialog[open]').waitFor();
await settle();
await shot('#calendarDialog', 'g-cal-dialog');
await shot('#dayPanel', 'g-cal-day-review');
await shot('#monthPanel', 'g-cal-month');
const missed = page.locator('#dayBody .choice').nth(1);
await missed.locator('input[type=number]').fill('20');
await missed.getByRole('button', { name: '누락 확인 + 보완 계획' }).click();
await page.waitForFunction(day => document.querySelector(`#calendarGrid .day[data-date="${day}"]`)
  ?.classList.contains('state-missed'), offset(-1));
await page.locator(`#calendarGrid .day[data-date="${offset(-1)}"]`).click();
await shot('#dayPanel', 'g-cal-day-missed');
await page.click('#calendarClose');
await page.waitForFunction(() => !document.querySelector('#calendarDialog').open);
await page.setViewportSize({ width: 1100, height: 900 });

// ---- 교재 ----
await page.click('#appTabs a[href="#source"]');
await page.locator('#sourcePageList li').nth(2).waitFor();
await page.fill('#sourceSearch', '형성평가');
await page.waitForFunction(() => document.querySelector('#sourceSearchResult').textContent.includes('곳'));
await shot('#view-source', 'g-source');

// ---- 학습실 ----
const action = label => page.locator(`[data-action="${label}"]`).first();
const field = name => page.locator(`[data-field="${name}"]`);
await page.click('#appTabs a[href="#study"]');
await page.locator('#studyNew').waitFor();
await field('subject').fill('교육학');
await field('studiedSection').fill('4장 교육평가의 유형');
await field('goal').fill('평가 유형의 목적 구분');
await field('question').fill('형성평가의 목적과 결과 활용 방식을 총괄평가와 비교하여 설명하시오.');
await field('firstAnswer').fill('형성평가는 학기 중간에 보는 시험으로, 중간 성적을 매겨 학생을 서열화하는 데 쓴다. 총괄평가는 학기 말에 본다.');
await shot('#view-study', 'g-study-1');
await action('기록 저장').click();
await page.locator('[data-step="2"].open').waitFor();
await page.locator('.evidence-list input[type=checkbox]').nth(0).check();
await page.waitForFunction(() => document.querySelector('[data-note="2"]')?.textContent.includes('1개'));
await page.locator('.evidence-list input[type=checkbox]').nth(1).check();
await page.waitForFunction(() => document.querySelector('[data-note="2"]')?.textContent.includes('2개'));
await page.locator('.evidence-list .link-button').first().click();
await shot('[data-step="2"]', 'g-study-2');
await action('원문과 대조 시작').click();
await page.locator('[data-step="3"].open .compare').waitFor();
await field('missing').fill('수업 개선과 피드백이라는 목적, 총괄평가의 결과 활용(성적·자격·배치)');
await field('mistaken').fill('형성평가를 성적 산출·서열화용으로 알았다');
await action('대조 내용 저장').click();
await page.waitForFunction(() => document.querySelector('[data-note="3"]')?.textContent.includes('저장했습니다'));
await page.locator('[data-step="3"] .compare').screenshot({ path: join(shots, 'g-study-3-compare.png') });
await shot('[data-step="3"]', 'g-study-3');

// ---- 내 AI에게 검토받기 ----
await page.selectOption('[data-ai-field="provider"]', 'ChatGPT');
await page.locator('.ai-consent').waitFor();
await shot('.ai-consent', 'g-ai-consent');
await page.check('input[name="ai-rights"][value="confirmed"]');
await page.check('[data-ai-field="agree"]');
await action('동의하고 요청문 만들기').click();
await page.locator('[data-form-field="ai-request"]').waitFor();
const example = ['[현재 자료에 근거한 설명] 첫 답안은 형성평가를 성적 산출·서열화용으로 설명했으나, 원문은 형성평가의 목적을 「교수 방법과 학습 활동을 개선」하는 것으로, 결과는 「성적 산출보다 피드백 제공에 주로」 쓰인다고 설명합니다(PDF 1쪽). 성적 부여·자격 판정·배치 결정은 원문이 총괄평가의 활용으로 드는 항목입니다(PDF 2쪽).',
  '[일반 지식에 근거한 보충 설명] 「서열화」는 보통 규준지향평가와 연결해 설명합니다. 교재에서 확인이 필요합니다.',
  '고쳐 쓸 때: 두 평가를 같은 기준(목적·결과 활용)으로 나란히 비교했는지 확인해 보십시오.',
  '', '[학습로그 후보]',
  '- 오개념 수정 | 형성평가의 목적 | 형성평가는 서열화용이 아니라 학습 개선과 피드백이 목적이다(PDF 1쪽).',
  '- 핵심 개념 | 총괄평가의 결과 활용 | 성적 부여·자격 판정·다음 교육과정 배치 결정(PDF 2쪽).',
  '- 확인 필요 | 준거지향과 규준지향 | 두 해석 기준의 정의를 교재에서 확인한다.'].join('\n');
await page.fill('[data-form-field="ai-response"]', example);
await shot('.ai-section', 'g-ai-request');
await action('AI 답 저장').click();
await page.waitForFunction(() => document.querySelector('[data-note="ai"]')?.textContent.includes('후보 3개'));
await shot('.ai-reviews', 'g-ai-saved');
await shot('.candidate-block', 'g-ai-candidates');
await page.locator('.candidate').first().getByRole('button', { name: '승인', exact: true }).click();
await page.waitForFunction(() => document.querySelectorAll('.candidate').length === 2);
await page.locator('.candidate').first().getByRole('button', { name: '승인', exact: true }).click();
await page.waitForFunction(() => document.querySelectorAll('.candidate').length === 1);

// ---- logs, step 4, wrap-up ----
await page.click('[data-log-type="INSIGHT"]');
await page.fill('[data-form-field="log-content"]', '비교 문항은 비교 기준(목적·결과 활용)을 먼저 세우고 두 대상을 같은 기준으로 나란히 쓴다.');
await shot('.log-form', 'g-log-form');
await action('로그 저장').click();
await page.waitForFunction(() => document.querySelector('[data-note="log"]')?.textContent.includes('저장했습니다'));
await shot('.log-section', 'g-logs');
await page.click('[data-step="4"] .step-toggle');
await field('revision').fill('형성평가는 수업이 진행되는 도중에 학습 진전을 확인해 교수 방법과 학습 활동을 개선하려고 실시하며, 결과는 주로 피드백에 쓰인다. 총괄평가는 일정 기간의 수업이 끝난 뒤 목표 달성 정도를 종합 판정하며, 결과는 성적 부여·자격 판정·배치 결정에 쓰인다.');
await field('reflection').fill('「비교하여」 문항은 기준부터 세운다.');
await page.selectOption('[data-field="mainCause"]', '비슷한 개념과 혼동함');
await page.locator('[data-other-cause][value="문항 요구를 빠뜨림"]').check();
await field('nextAction').fill('세 평가(진단·형성·총괄)를 목적·결과 활용 표로 정리하기');
await field('reviewDate').fill(offset(3));
await action('저장').click();
await page.waitForFunction(() => document.querySelector('[data-note="4"]')?.textContent.includes('저장했습니다'));
await shot('[data-step="4"]', 'g-study-4');
await action('학습 마무리').click();
await page.locator('[data-form-field="summary-content"]').waitFor();
await shot('.summary-section', 'g-summary-draft');
await action('요약 승인').click();
await page.locator('.summary-card').waitFor();
await page.locator('#studyList').screenshot({ path: join(shots, 'g-study-list.png') });

// ---- 오답노트 ----
await page.click('#appTabs a[href="#notes"]');
await page.selectOption('#notesScope', 'all');
await page.locator('.note-card').first().waitFor();
await shot('#view-notes', 'g-notes');

// ---- 내 기록 ----
await page.click('#appTabs a[href="#data"]');
await page.locator('#dataPanel').waitFor();
await Promise.all([page.waitForEvent('download'), page.click('#backupButton')]);
await page.waitForFunction(() => document.querySelector('#storageStatus').textContent.includes('마지막 백업'));
await shot('#dataPanel', 'g-data');
await shot('#dataPanel', 'w6-data-after');
await page.waitForFunction(() => document.querySelector('#aiConsentList li[data-consent-id]'));
await shot('#aiConsentPanel', 'g-ai-consents');
await page.waitForFunction(() => document.querySelector('#wikiCheck').textContent.includes('형식 검사'));
await shot('#wikiPanel', 'g-wiki');
await page.screenshot({ path: join(shots, 'g-data-page.png'), fullPage: true });

await browser.close();
server.close();
console.log('done', offset(0));
