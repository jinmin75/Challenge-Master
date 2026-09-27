// Captures the app screens for the student guide with headless Chrome against a local test server.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const guide = join(import.meta.dirname, '..');
const shots = join(guide, 'shots');
const pdf = join(guide, 'sample.pdf');
const project = process.argv[2];

const data = mkdtempSync(join(tmpdir(), 'cm-guide-data-'));
const server = spawn(process.execPath, ['src/desktop.mjs', '--no-browser'], {
  cwd: project, env: { ...process.env, CHALLENGE_MASTER_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'inherit'],
});
const url = await new Promise(done => {
  let out = '';
  server.stdout.on('data', c => { out += c; const m = out.match(/(http:\/\/127\.0\.0\.1:\d+\/)/); if (m) done(m[1]); });
});

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
const card = sel => page.locator(sel).locator('xpath=ancestor-or-self::*[self::section or self::header or contains(concat(" ", normalize-space(@class), " "), " panel ")][1]');
const shot = (sel, name, own = false) => (own ? page.locator(sel) : card(sel)).screenshot({ path: join(shots, `${name}.png`) });

await page.goto(url, { waitUntil: 'networkidle' });
console.log('widths', await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]));
await shot('#startButton', 's1-top-demo');
await page.locator('#pdfInput').setInputFiles(pdf);
await page.fill('#titleInput', '교육학 1회독');
await page.fill('#tasksInput', '1장 교육철학 핵심 개념 | 40 | 새 내용\n지난주 요약 다시 보기 | 20 | 복습');
await page.fill('#dailyMinutesInput', '60');
await page.fill('#weeklyMinutesInput', '300');
await page.fill('#pageEndInput', '3');
await shot('#setupForm', 's2-form', true);
await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/setup')),
  page.getByRole('button', { name: '이 설정으로 시작' }).click()]);
await page.waitForTimeout(1200);
await shot('#extractionPanel', 's3-extraction', true);
await shot('#startButton', 's3-top-registered');
await page.locator('#startButton').click();
await page.waitForTimeout(1200);
await shot('#startButton', 's4-top-started');
await shot('#allocations', 's4-today');
await page.fill('#minutesInput', '20');
await shot('#progressForm', 's4-record', true);
await shot('#shortenForm', 's4-shorten', true);
await shot('#restButton', 's4-rest');
await page.getByRole('button', { name: '기록', exact: true }).click();
await page.waitForTimeout(1200);
await shot('#confirmedMinutes', 's5-status');
await shot('#weekAllocations', 's5-week');
await page.locator('#quitButton').click();
await page.waitForTimeout(1200);
await shot('#startButton', 's6-quit');
await browser.close();
server.kill();
console.log('done');
