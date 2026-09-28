// Browser steps shared by the local-app check (browser-calendar.mjs) and the web-version check (browser-web.mjs).
// playwright-core is not a project dependency (npm on the synced Drive folder writes empty files); pass a local
// install with PLAYWRIGHT_CORE=<path to node_modules/playwright-core>.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localDate } from '../src/app-core.mjs';

export async function loadPlaywright() {
  const path = process.env.PLAYWRIGHT_CORE;
  return import(path ? pathToFileURL(join(path, 'index.mjs')).href : 'playwright-core');
}

export function offset(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localDate(date);
}

// Console errors and failed requests (by URL; the console repeats them without it). favicon.ico has no file.
export function watchPage(page) {
  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) consoleErrors.push(message.text());
  });
  page.on('pageerror', error => consoleErrors.push(error.message));
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 400 && !path.endsWith('/favicon.ico')) failedRequests.push(`${response.status()} ${path}`);
  });
  return { consoleErrors, failedRequests };
}

// L25 on a page whose records have plans on day -3 and today, and nothing on -3..-1.
// calendarOf(date) returns the stored month for that date, read outside the screen.
export async function calendarFlow(page, { calendarOf }) {
  const dayOf = async date => (await calendarOf(date)).days.find(day => day.date === date);
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
}
