import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, startServer } from '../src/web.mjs';
import { readStore } from '../src/store.mjs';

const planInput = {
  date: '2026-09-23',
  availableMinutes: 60,
  remainingStudyMinutes: 80,
  tasks: [
    { id: 'unit1', title: '첫 단원', kind: 'new', minutes: 20, splittable: true },
    { id: 'review1', title: '지난 내용 확인', kind: 'review', minutes: 12, splittable: true, dueDate: '2026-09-22' },
  ],
};

async function withServer(fn, input = planInput) {
  const dir = mkdtempSync(join(tmpdir(), 'challenge-master-web-'));
  const storeFile = join(dir, 'study.json');
  const server = createServer({ storeFile, planInput: input });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ baseUrl, storeFile });
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

async function request(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  assert.equal(response.status, 200, data.error);
  return data;
}

async function rawRequest(baseUrl, path, { body, headers = {}, method = 'POST' } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body,
  });
}

test('web API starts a local plan and returns one recommended action', async () => {
  await withServer(async ({ baseUrl, storeFile }) => {
    const before = await request(baseUrl, '/api/status');
    assert.equal(before.currentPlan, null);
    assert.equal(before.recommendedAction.kind, 'start');

    const started = await request(baseUrl, '/api/start', { date: '2026-09-23' });
    assert.equal(started.currentPlan.planVersion, 1);
    assert.equal(started.recommendedAction.kind, 'study');
    assert.equal(typeof started.recommendedAction.label, 'string');
    assert.equal(readStore(storeFile).events[0].type, 'plan_created');
  });
});

test('confirmed minutes reduce the next plan while attempts remain separate evidence', async () => {
  await withServer(async ({ baseUrl }) => {
    const started = await request(baseUrl, '/api/start', { date: '2026-09-23' });
    const taskId = started.recommendedAction.taskId;

    await request(baseUrl, '/api/attempt', { taskId, response: '짧은 답안', evidenceType: 'observed_attempt' });
    const afterProgress = await request(baseUrl, '/api/progress', { taskId, completedMinutes: 5 });
    assert.equal(afterProgress.confirmedProgressMinutes, 5);
    assert.equal(afterProgress.attempts.length, 1);
    assert.equal(afterProgress.progress.length, 1);
    assert.equal(afterProgress.recommendedAction.taskId, taskId);
    assert.equal(afterProgress.recommendedAction.minutes, 15);
    assert.equal(afterProgress.currentPlan.allocations.find(item => item.taskId === taskId)?.minutes, 15);
    assert.equal(afterProgress.rawCurrentPlan.allocations.find(item => item.taskId === taskId)?.minutes, 20);

    const shortened = await request(baseUrl, '/api/shorten', { date: '2026-09-23', availableMinutes: 30 });
    const allocation = shortened.currentPlan.allocations.find(item => item.taskId === taskId);
    assert.equal(allocation?.minutes, 15);
    assert.match(shortened.progressContract, /직접 확인한 실제 공부 시간/);
  });
});

test('rest and skip do not turn work into completed progress', async () => {
  await withServer(async ({ baseUrl }) => {
    const started = await request(baseUrl, '/api/start', { date: '2026-09-23' });
    const taskId = started.recommendedAction.taskId;

    const skipped = await request(baseUrl, '/api/skip', { taskId });
    assert.equal(skipped.noncompletion.length, 1);
    assert.equal(skipped.confirmedProgressMinutes, 0);
    assert.notEqual(skipped.recommendedAction.taskId, taskId);
    assert.equal(skipped.rawCurrentPlan.allocations.some(item => item.taskId === taskId), true);

    const replanned = await request(baseUrl, '/api/start', { date: '2026-09-24' });
    assert.equal(replanned.currentPlan.allocations.some(item => item.taskId === taskId), true);

    const rested = await request(baseUrl, '/api/rest', { date: '2026-09-23' });
    assert.equal(rested.currentPlan.allocatableMinutes, 0);
    assert.equal(rested.recommendedAction.kind, 'wait');
    assert.equal(rested.confirmedProgressMinutes, 0);
  });
});

test('API rejects cross-origin and non-JSON POST requests', async () => {
  await withServer(async ({ baseUrl }) => {
    let response = await rawRequest(baseUrl, '/api/start', {
      headers: { origin: 'http://example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ date: '2026-09-23' }),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /로컬호스트/);

    response = await rawRequest(baseUrl, '/api/start', {
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ date: '2026-09-23' }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /JSON/);
  });
});

test('server startup stays bound to localhost addresses', async () => {
  assert.throws(() => startServer({ host: '0.0.0.0', port: 0, planInput }), /로컬호스트/);
  assert.throws(() => createServer({ planInput: { ...planInput, completedTaskIds: ['unit1'] } }), /completedTaskIds/);
});

test('the same progress request id records minutes only once', async () => {
  await withServer(async ({ baseUrl, storeFile }) => {
    const started = await request(baseUrl, '/api/start', { date: '2026-09-23' });
    const requestId = randomUUID();
    const body = { requestId, taskId: started.recommendedAction.taskId, completedMinutes: 5 };
    const first = await request(baseUrl, '/api/progress', body);
    const repeated = await request(baseUrl, '/api/progress', body);
    assert.equal(first.confirmedProgressMinutes, 5);
    assert.equal(repeated.confirmedProgressMinutes, 5);
    assert.equal(readStore(storeFile).progress.length, 1);
    const conflict = await fetch(`${baseUrl}/api/progress`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, completedMinutes: 6 })
    });
    assert.equal(conflict.status, 400);
  });
});

test('web status refreshes weekly forecast from confirmed progress and configured week days', async () => {
  const input = {
    ...planInput,
    weekDays: [
      { date: '2026-09-23', availableMinutes: 20 },
      { date: '2026-09-24', availableMinutes: 20 },
    ],
  };
  await withServer(async ({ baseUrl }) => {
    const started = await request(baseUrl, '/api/start', { date: '2026-09-23' });
    const taskId = started.recommendedAction.taskId;
    const before = await request(baseUrl, '/api/status');
    assert.equal(before.weeklyForecast.tentativeAllocations.every(item => item.status === 'tentative'), true);
    assert.equal(before.weeklyForecast.startDate, '2026-09-23');

    const after = await request(baseUrl, '/api/progress', { taskId, completedMinutes: 5 });
    assert.equal(after.weeklyForecast.totalObservedCompletedMinutes, 5);
    assert.deepEqual(after.weeklyForecast.observedProgress, [{ taskId, minutes: 5, status: 'observed' }]);
    assert.equal(Array.isArray(after.weeklyForecast.deferredScope), true);
  }, input);
});

test('weekly forecast follows the current shortened or rest plan', async () => {
  await withServer(async ({ baseUrl }) => {
    const started = await request(baseUrl, '/api/start', { date: '2026-09-23' });
    assert.equal(started.weeklyForecast.days[0].availableMinutes, 60);
    const shortened = await request(baseUrl, '/api/shorten', {
      date: '2026-09-23', availableMinutes: 30
    });
    assert.equal(shortened.weeklyForecast.days[0].availableMinutes, 30);
    assert.equal(shortened.weeklyForecast.days[0].allocatableMinutes, 27);
    const rested = await request(baseUrl, '/api/rest', { date: '2026-09-23' });
    assert.equal(rested.weeklyForecast.days[0].assignedMinutes, 0);
    assert.equal(rested.weeklyForecast.days[0].allocatableMinutes, 0);
  }, { ...planInput, weekDays: [
    { date: '2026-09-23', availableMinutes: 20 },
    { date: '2026-09-24', availableMinutes: 20 }
  ] });
});

test('weekly forecast error does not hide a saved daily plan', async () => {
  await withServer(async ({ baseUrl, storeFile }) => {
    const started = await request(baseUrl, '/api/start', { date: '2026-09-23' });
    assert.equal(started.currentPlan.planVersion, 1);
    assert.equal(started.weeklyForecast, null);
    assert.match(started.weeklyForecastError, /주간 예측을 갱신하지 못했습니다/);
    assert.equal(readStore(storeFile).events.length, 1);
  }, { ...planInput, weekDays: [
    { date: '2026-09-24', availableMinutes: 30 },
    { date: '2026-09-23', availableMinutes: 30 }
  ] });
});

test('static UI is served from the local web root', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Challenge Master/);
    assert.match(html, /실제 공부 시간 기록/);
  });
});
