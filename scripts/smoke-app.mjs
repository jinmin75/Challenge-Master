// Shared end-to-end flow for packaged-app smoke tests (Windows installer, macOS app bundle).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const children = new Set();

export function syntheticPdf() {
  const content = 'BT /F1 14 Tf 72 720 Td (Installed PDF smoke test) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// Starts a packaged app in the foreground and resolves with the local URL it prints.
export function startApp({ command, args, cwd, env }) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(child);
  const ready = new Promise((done, fail) => {
    let output = '';
    let errors = '';
    const timer = setTimeout(() => fail(new Error(`Installed app startup timeout: ${errors}`)), 20000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/Challenge Master: (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) { clearTimeout(timer); done(match[1]); }
    });
    child.stderr.on('data', chunk => { errors += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('exit', code => {
      children.delete(child);
      if (!output.includes('Challenge Master:')) {
        clearTimeout(timer);
        fail(new Error(`Installed app exited ${code}: ${errors}`));
      }
    });
  });
  return { child, ready };
}

export async function json(url, path, body) {
  const response = await fetch(new URL(path, url), body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, 200, result.error ?? JSON.stringify(result));
  return result;
}

export async function closeApp(url, child) {
  await json(url, '/api/quit', {});
  if (child.exitCode !== null) return;
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('Installed app did not exit')), 10000);
    child.once('exit', () => { clearTimeout(timer); done(); });
  });
}

// First run: register a PDF, start a plan, record 5 minutes. Second run: the record survives.
export async function exerciseApp(launch, dataRoot) {
  const first = launch();
  const firstUrl = await first.ready;
  const before = await json(firstUrl, '/api/status');
  assert.equal(before.setup.configured, false);

  const pdf = syntheticPdf();
  const form = new FormData();
  form.append('pdf', new Blob([pdf], { type: 'application/pdf' }), 'installed-smoke.pdf');
  form.append('title', '설치본 검증 자료');
  form.append('pageStart', '1');
  form.append('pageEnd', '1');
  form.append('dailyMinutes', '40');
  form.append('weeklyMinutes', '200');
  form.append('tasks', '합성 1쪽 읽기 | 30 | new');
  const setupResponse = await fetch(new URL('/api/setup', firstUrl), { method: 'POST', body: form });
  const setup = await setupResponse.json();
  assert.equal(setupResponse.status, 200, setup.error ?? JSON.stringify(setup));
  assert.deepEqual(setup.setup.source.pages.map(page => [page.status, page.hasText]), [['needs_review', true]]);
  const saved = JSON.parse(readFileSync(join(dataRoot, 'setup.json'), 'utf8'));
  assert.deepEqual(readFileSync(saved.source.storedFile), pdf);
  assert.match(readFileSync(saved.source.extraction.draftFile, 'utf8'), /Installed PDF smoke test/);
  assert.deepEqual(saved.source.extraction.summary.readyPages, []);

  const date = new Date().toLocaleDateString('en-CA');
  const started = await json(firstUrl, '/api/start', { date });
  assert.ok(started.currentPlan.allocations.length > 0);
  const taskId = started.currentPlan.allocations[0].taskId;
  const progressed = await json(firstUrl, '/api/progress', {
    requestId: randomUUID(), taskId, completedMinutes: 5,
  });
  assert.equal(progressed.confirmedProgressMinutes, 5);
  await closeApp(firstUrl, first.child);

  const second = launch();
  const secondUrl = await second.ready;
  const restored = await json(secondUrl, '/api/status');
  assert.equal(restored.setup.configured, true);
  assert.equal(restored.confirmedProgressMinutes, 5);
  assert.ok(restored.weeklyForecast);
  await closeApp(secondUrl, second.child);
  return restored;
}
