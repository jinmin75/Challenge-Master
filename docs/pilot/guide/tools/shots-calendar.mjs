// Captures the v0.7 calendar screens for the student guide. The records are synthetic and dated relative to
// today: registered 5 days ago, studied 5 and 4 days ago, a confirmed rest day, then two days without records.
// Usage (from a local copy with playwright-core installed): node shots-calendar.mjs <repository path>
import { chromium } from 'playwright-core';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const project = process.argv[2];
const shots = join(import.meta.dirname, '..', 'shots');
mkdirSync(shots, { recursive: true });
const { createServer } = await import(pathToFileURL(join(project, 'src', 'web.mjs')).href);
const { localDate } = await import(pathToFileURL(join(project, 'src', 'app-core.mjs')).href);
const offset = days => { const date = new Date(); date.setDate(date.getDate() + days); return localDate(date); };

const input = { availableMinutes: 60, remainingStudyMinutes: 180, tasks: [
  { id: 'unit1', title: '1장 교육철학 핵심 개념', kind: 'new', minutes: 60, splittable: true },
  { id: 'review1', title: '지난주 요약 다시 보기', kind: 'review', minutes: 120, splittable: true }] };
const server = createServer({ storeFile: join(mkdtempSync(join(tmpdir(), 'cm-guide-cal-')), 'study.json'),
  planInput: { ...input, date: localDate() } });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (path, body) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: ${(await response.json()).error}`);
};
await post('/api/start', { date: offset(-5) });
await post('/api/progress', { taskId: 'unit1', completedMinutes: 20 });
await post('/api/start', { date: offset(-4) });
await post('/api/progress', { taskId: 'review1', completedMinutes: 30 });
await post('/api/day-review', { date: offset(-3), status: 'rest' });
await post('/api/start', { date: offset(0) });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
const shot = async (selector, name) => {
  await page.mouse.move(0, 0); // no hover colour in the picture
  await page.locator(selector).screenshot({ path: join(shots, `${name}.png`) });
};
await page.goto(base, { waitUntil: 'networkidle' });
await page.locator('#calendarGrid .day.selected').waitFor();
await shot('#calendarPanel', 's7-calendar');
await shot('#dayPanel', 's7-day-review');
await shot('#monthPanel', 's7-month');

// The newest day: did not study, make-up time added to tomorrow.
const missed = page.locator('#dayBody .choice').nth(1);
await missed.locator('input[type=number]').fill('20');
await missed.getByRole('button', { name: '누락 확인 + 보완 계획' }).click();
await page.waitForFunction(day => document.querySelector(`#calendarGrid .day[data-date="${day}"]`)
  ?.classList.contains('state-missed'), offset(-1));
await page.locator(`#calendarGrid .day[data-date="${offset(-1)}"]`).click();
await page.waitForTimeout(300);
await shot('#calendarPanel', 's7-calendar-after');
await shot('#dayPanel', 's7-day-missed');
await browser.close();
server.close();
console.log('done', offset(-1));
