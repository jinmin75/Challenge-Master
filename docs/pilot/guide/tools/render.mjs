// Renders the guide HTML files to A4 PDFs and page previews with headless Chrome.
import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const guide = join(import.meta.dirname, '..');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
for (const name of process.argv.slice(2)) {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(join(guide, `${name}.html`)).href, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const font = await page.evaluate(() => document.fonts.check('16px Paperlogy'));
  await page.pdf({ path: join(guide, `${name}.pdf`), format: 'A4', printBackground: true, preferCSSPageSize: true });
  // Page previews: emulate print media and snapshot each A4 page at screen scale for review.
  await page.emulateMedia({ media: 'print' });
  await page.setViewportSize({ width: 794, height: 1123 });
  await page.screenshot({ path: join(guide, `${name}-preview.png`), fullPage: true });
  console.log(name, 'paperlogy loaded:', font);
  await page.close();
}
await browser.close();
