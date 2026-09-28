// L25: drive the calendar in a real (headless) Chrome and compare the screen with the server records.
// playwright-core is not a project dependency (npm on the synced Drive folder writes empty files), so pass
// a local install: PLAYWRIGHT_CORE=C:\path\to\node_modules\playwright-core node scripts/browser-calendar.mjs [shot.png]
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localDate } from '../src/app-core.mjs';
import { createServer } from '../src/web.mjs';
import { calendarFlow, loadPlaywright, offset, watchPage } from './browser-flows.mjs';

const { chromium } = await loadPlaywright();
const shot = process.argv[2] ?? null;

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

// Registered three days ago; today already has a plan. Days -3, -2 and -1 have no records.
await post('/api/start', { date: offset(-3) });
await post('/api/start', { date: offset(0) });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const { consoleErrors, failedRequests } = watchPage(page);
  await page.goto(base, { waitUntil: 'networkidle' });
  await calendarFlow(page, { calendarOf });
  if (shot) await page.screenshot({ path: shot, fullPage: true });
  assert.deepEqual(consoleErrors, []);
  // The only failed request is the deliberate over-cap make-up.
  assert.deepEqual(failedRequests, ['400 /api/makeup']);
  console.log('browser calendar check passed');
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
