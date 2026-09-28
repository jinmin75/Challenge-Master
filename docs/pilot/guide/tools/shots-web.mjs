// Captures the web-version screens (D022) for the student guide from a running site in headless Chrome.
// Usage (from a local copy with playwright-core installed): node shots-web.mjs <site URL>
// Needs ../sample.pdf (2 text pages + 1 image-only page), like shots.mjs. Pictures go to ../shots/.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const site = process.argv[2];
const guide = join(import.meta.dirname, '..');
const shots = join(guide, 'shots');
mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2,
  locale: 'ko-KR', acceptDownloads: true });
const page = await context.newPage();
const card = selector => page.locator(selector).locator('xpath=ancestor-or-self::*[self::section or self::header or contains(concat(" ", normalize-space(@class), " "), " panel ")][1]');
const shot = async (selector, name, own = false) => {
  await page.mouse.move(0, 0);
  await (own ? page.locator(selector) : card(selector)).screenshot({ path: join(shots, `${name}.png`) });
};

await page.goto(site, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !document.querySelector('#recommendation').textContent.includes('불러오는 중'));
await shot('#startButton', 'w1-top-demo');
await page.locator('#pdfInput').setInputFiles(join(guide, 'sample.pdf'));
await page.fill('#titleInput', '교육학 1회독');
await page.fill('#tasksInput', '1장 교육철학 핵심 개념 | 40 | 새 내용\n지난주 요약 다시 보기 | 20 | 복습');
await page.fill('#dailyMinutesInput', '60');
await page.fill('#weeklyMinutesInput', '300');
await page.fill('#pageEndInput', '3');
await shot('#setupForm', 'w2-form', true);
await page.getByRole('button', { name: '이 설정으로 시작' }).click();
await page.locator('#extractionPages li').nth(2).waitFor();
await shot('#extractionPanel', 'w3-extraction', true);
await shot('#startButton', 'w3-top-registered');
await page.locator('#startButton').click();
await page.locator('#allocations li').first().waitFor();
await shot('#startButton', 'w4-top-started');
await shot('#allocations', 'w4-today');
await page.fill('#minutesInput', '20');
await shot('#progressForm', 'w4-record', true);
await shot('#shortenForm', 'w4-shorten', true);
await shot('#restButton', 'w4-rest');
await page.getByRole('button', { name: '기록', exact: true }).click();
await page.waitForFunction(() => document.querySelector('#confirmedMinutes').textContent === '20분');
await shot('#confirmedMinutes', 'w5-status');
await shot('#weekAllocations', 'w5-week');
await page.locator('#backupNotice:not([hidden])').waitFor();
await shot('#startButton', 'w6-top-backup-notice');
await shot('#dataPanel', 'w6-data-before', true);
await Promise.all([page.waitForEvent('download'), page.click('#backupButton')]);
await page.waitForFunction(() => document.querySelector('#storageStatus').textContent.includes('마지막 백업'));
await shot('#dataPanel', 'w6-data-after', true);
await browser.close();
console.log('done');
