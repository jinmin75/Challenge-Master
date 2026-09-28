// L25: drive the calendar in a real (headless) Chrome and compare the screen with the server records.
// playwright-core is not a project dependency (npm on the synced Drive folder writes empty files), so pass
// a local install: PLAYWRIGHT_CORE=C:\path\to\node_modules\playwright-core node scripts/browser-calendar.mjs [shot.png]
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localDate } from '../src/app-core.mjs';
import { createServer } from '../src/web.mjs';

const playwrightPath = process.env.PLAYWRIGHT_CORE;
const { chromium } = await import(playwrightPath ? pathToFileURL(join(playwrightPath, 'index.mjs')).href : 'playwright-core');
const shot = process.argv[2] ?? null;

function offset(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localDate(date);
}

const input = {
  availableMinutes: 60,
  remainingStudyMinutes: 180,
  tasks: [
    { id: 'unit1', title: '새 단원', kind: 'new', minutes: 60, splittable: true },
    { id: 'review1', title: '복습 확인', kind: 'review', minutes: 120, splittable: true },
  ],
};
const server = createServer({ storeFile: join(mkdtempSync(join(tmpdir(), 'challenge-browser-')), 'study.json'),
  planInput: { ...input, date: localDate() } });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body) }).then(response => response.json());
const calendarOf = date => fetch(`${base}/api/calendar?month=${date.slice(0, 7)}`).then(response => response.json());
const dayOf = async date => (await calendarOf(date)).days.find(day => day.date === date);

// Registered three days ago; today already has a plan. Days -3, -2 and -1 have no records.
await post('/api/start', { date: offset(-3) });
await post('/api/start', { date: offset(0) });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const consoleErrors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  // Failed requests are checked by URL below; the console only repeats them without the URL.
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) consoleErrors.push(message.text());
  });
  const failedRequests = [];
  page.on('response', response => {
    if (response.status() >= 400) failedRequests.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  page.on('pageerror', error => consoleErrors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('#calendarGrid .day[data-date]').first().waitFor();

  const cell = date => page.locator(`#calendarGrid .day[data-date="${date}"]`);
  async function openDay(date) {
    for (let tries = 0; tries < 2 && await cell(date).count() === 0; tries += 1) {
      const shown = await page.locator('#calendarGrid .day[data-date]').first().getAttribute('data-date');
      await page.click(date.slice(0, 7) < shown.slice(0, 7) ? '#calendarPrev' : '#calendarNext');
      await page.locator('#calendarGrid .day[data-date]').first().waitFor();
    }
    await cell(date).click();
    await page.waitForFunction(selected => document.querySelector('#calendarGrid .day.selected')?.dataset.date === selected, date);
  }
  const waitState = (date, state) => page.waitForFunction(([day, name]) =>
    document.querySelector(`#calendarGrid .day[data-date="${day}"]`)?.classList.contains(`state-${name}`), [date, state]);

  for (const day of [-3, -2, -1]) {
    await openDay(offset(day));
    assert.ok(await cell(offset(day)).evaluate(node => node.classList.contains('state-needs_review')), `${offset(day)} needs review`);
  }

  // 1. Studied but did not record: late progress.
  await openDay(offset(-3));
  const lateChoice = page.locator('#dayBody .choice').nth(0);
  await lateChoice.locator('input[type=number]').fill('10');
  await lateChoice.getByRole('button', { name: '사후 기록' }).click();
  await waitState(offset(-3), 'late');
  assert.equal((await dayOf(offset(-3))).lateMinutes, 10);

  // 2. Did not study: missed + make-up tomorrow.
  await openDay(offset(-2));
  const missedChoice = page.locator('#dayBody .choice').nth(1);
  await missedChoice.locator('input[type=number]').fill('20');
  await missedChoice.getByRole('button', { name: '누락 확인 + 보완 계획' }).click();
  await waitState(offset(-2), 'missed');
  assert.equal((await dayOf(offset(-2))).makeupScheduledFor, 20);
  assert.equal((await dayOf(offset(1))).makeupMinutes, 20);

  // Over the one-day cap: the error is shown and nothing more is saved.
  await openDay(offset(-2));
  await page.locator('#dayBody .choice input[type=number]').fill('50');
  await page.getByRole('button', { name: '보완 계획 추가' }).click();
  await page.locator('#errorMessage:not([hidden])').waitFor();
  assert.match(await page.locator('#errorMessage').textContent(), /하루 공부 시간\(60분\)까지/);
  assert.equal((await dayOf(offset(1))).makeupMinutes, 20);

  // 3. A rest day.
  await openDay(offset(-1));
  await page.getByRole('button', { name: '쉬는 날이었어요' }).click();
  await waitState(offset(-1), 'rest');
  assert.equal((await dayOf(offset(-1))).review.status, 'rest');

  // The monthly check has nothing left to review for the current month.
  if (offset(-1).slice(0, 7) === offset(0).slice(0, 7)) {
    await openDay(offset(0));
    await page.waitForFunction(() => document.querySelector('#needsReviewList')?.textContent.includes('확인이 필요한 날이 없습니다'));
    assert.equal((await calendarOf(offset(0))).needsReview.length, 0);
  }

  // Month navigation changes the title and returns.
  const title = await page.locator('#calendarTitle').textContent();
  await page.click('#calendarNext');
  await page.waitForFunction(before => document.querySelector('#calendarTitle').textContent !== before, title);
  await page.click('#calendarPrev');
  await page.waitForFunction(before => document.querySelector('#calendarTitle').textContent === before, title);

  // Recording today's study through the existing form refreshes the calendar too.
  await page.locator('#minutesInput').fill('5');
  await page.locator('#progressForm button[type=submit]').click();
  await page.waitForFunction(day => document.querySelector(`#calendarGrid .day[data-date="${day}"]`)?.textContent.includes('확인 5'), offset(0));

  if (shot) await page.screenshot({ path: shot, fullPage: true });
  assert.deepEqual(consoleErrors, []);
  // The only failed request is the deliberate over-cap make-up; favicon.ico has no file.
  assert.deepEqual(failedRequests.filter(item => item !== '404 /favicon.ico'), ['400 /api/makeup']);
  console.log('browser calendar check passed');
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
