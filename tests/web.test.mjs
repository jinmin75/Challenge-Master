import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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

async function withServer(fn, input = planInput, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'challenge-master-web-'));
  const storeFile = join(dir, 'study.json');
  const server = createServer({ storeFile, planInput: input, ...options });
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

async function withOnboardingServer(fn, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'challenge-master-web-'));
  const storeFile = join(dir, 'study.json');
  const configFile = join(dir, 'setup.json');
  const sourceDir = join(dir, 'sources');
  const draftDir = join(dir, 'drafts');
  const archiveDir = join(dir, 'archives');
  const journalFile = join(dir, 'setup-transition.json');
  const server = createServer({ storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile, ...options });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ baseUrl, storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile, server, dir });
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
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

function fakePdfConverter(calls, { failedPages = [] } = {}) {
  return (input) => {
    calls.push(input);
    const selectedPages = [...input.selectedPages];
    const pages = Object.fromEntries(selectedPages.map(number => [String(number), {
      pdfPageIndex: number,
      printedPageLabel: String(number),
      markdown: failedPages.includes(number) ? '' : `추출 초안 ${number}`,
      status: failedPages.includes(number) ? 'failed' : 'needs_review',
      blocks: [],
      validation: {
        structureChecked: !failedPages.includes(number),
        sourceCompared: false,
        issues: ['원본 PDF와 텍스트·순서·표·수식 대조 필요'],
      },
    }]));
    const summary = {
      sourceId: input.sourceId,
      sourceHash: 'a'.repeat(64),
      conversionVersion: 'pypdf-layout-v1',
      selectedPages,
      readyPages: [],
      needsReviewPages: selectedPages.filter(number => !failedPages.includes(number)),
      failedPages,
      missingPages: [],
      status: 'partial',
      masteryEvidence: false,
    };
    return {
      manifest: { source: { ...summary, title: input.title }, pages },
      summary,
      draftMarkdown: '<!-- draft_only: do_not_use_as_verified_evidence -->\n원본 대조 필요\n',
    };
  };
}

function setupForm({
  title = '학생 자료',
  tasks = '1장 읽기 | 40 | 새 내용',
  pageStart = '1',
  pageEnd = '1',
} = {}) {
  const form = new FormData();
  form.append('pdf', new Blob([Buffer.from('%PDF-1.7\r\n%%EOF\r\n')], { type: 'application/pdf' }), 'sample.pdf');
  form.append('title', title);
  form.append('dailyMinutes', '45');
  form.append('weeklyMinutes', '120');
  form.append('pageStart', pageStart);
  form.append('pageEnd', pageEnd);
  form.append('tasks', tasks);
  return form;
}

function writeTransitionJournal({ journalFile, configFile, setupTemp, storeFile, storeArchiveFile,
  previousSetupArchiveFile, newSetupId, artifacts }) {
  writeFileSync(journalFile, JSON.stringify({
    schemaVersion: 1,
    journalFile,
    newSetupId,
    configFile,
    setupTemp,
    storeFile,
    storeArchiveFile,
    previousSetupArchiveFile,
    newArtifacts: artifacts,
  }, null, 2));
}

function fakeSetup(id, title, artifacts = {}) {
  return {
    schemaVersion: 1,
    id,
    title,
    dailyMinutes: 45,
    weeklyMinutes: 120,
    tasks: [{ title: `${title} 과업`, minutes: 40, kind: 'new' }],
    source: {
      originalName: `${title}.pdf`,
      storedFile: artifacts.storedFile ?? 'unused.pdf',
      sizeBytes: 15,
      uploadedAt: '2026-09-23T00:00:00.000Z',
      selectedPages: [1],
      extractionStatus: 'needs_review',
      extraction: {
        manifestFile: artifacts.manifestFile ?? 'unused.manifest.json',
        draftFile: artifacts.draftFile ?? 'unused.draft.md',
        summary: {
          sourceId: id,
          sourceHash: 'a'.repeat(64),
          conversionVersion: 'pypdf-layout-v1',
          selectedPages: [1],
          readyPages: [],
          needsReviewPages: [1],
          failedPages: [],
          missingPages: [],
          status: 'partial',
          masteryEvidence: false,
        },
      },
    },
  };
}

function setupId() {
  return `setup-${randomUUID()}`;
}

function validArtifacts(sourceDir, draftDir) {
  const sourceId = `local-pdf-${randomUUID()}`;
  return {
    storedFile: join(sourceDir, `${randomUUID()}.pdf`),
    manifestFile: join(draftDir, `${sourceId}.manifest.json`),
    draftFile: join(draftDir, `${sourceId}.draft.md`),
  };
}

function validSetupTemp(configFile) {
  return `${configFile}.${randomUUID()}.tmp`;
}

function validSetupArchive(archiveDir) {
  return join(archiveDir, `setup-${randomUUID()}.json`);
}

function validStoreArchive(archiveDir) {
  return join(archiveDir, `study-web-${randomUUID()}.json`);
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
    assert.match(html, /내 PDF로 공부 계획 만들기/);
    assert.match(html, /실제 공부 시간 기록/);
  });
});

test('student setup stores PDF bytes, extracts the selected pages, and plans from entered tasks', async () => {
  const convertCalls = [];
  await withOnboardingServer(async ({ baseUrl, configFile }) => {
    const before = await request(baseUrl, '/api/status');
    assert.equal(before.setup.configured, false);
    assert.equal(before.planSource, 'synthetic_demo');

    const pdfBytes = Buffer.from('%PDF-1.7\r\n1 0 obj\r\n%%EOF\r\n', 'latin1');
    const form = new FormData();
    form.append('pdf', new Blob([pdfBytes], { type: 'application/pdf' }), 'sample.pdf');
    form.append('title', '학생 자료');
    form.append('dailyMinutes', '45');
    form.append('weeklyMinutes', '120');
    form.append('pageStart', '1');
    form.append('pageEnd', '2');
    form.append('tasks', '1장 읽기 | 40 | 새 내용\n복습 문제 | 20 | 복습');
    const setupResponse = await fetch(`${baseUrl}/api/setup`, { method: 'POST', body: form });
    const setupStatus = await setupResponse.json();
    assert.equal(setupResponse.status, 200, setupStatus.error);
    assert.equal(setupStatus.setup.configured, true);
    assert.equal(setupStatus.setup.source.originalName, 'sample.pdf');
    assert.equal(setupStatus.setup.source.extractionStatus, 'needs_review');
    assert.deepEqual(setupStatus.setup.source.selectedPages, [1, 2]);
    assert.deepEqual(setupStatus.setup.source.pages.map(page => page.status), ['needs_review', 'needs_review']);
    assert.equal(setupStatus.setup.source.pages.every(page => page.reviewRequired), true);
    assert.match(setupStatus.planSource, /local_setup:sample\.pdf/);

    const saved = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.deepEqual(readFileSync(saved.source.storedFile), pdfBytes);
    assert.deepEqual(convertCalls.map(call => call.selectedPages), [[1, 2]]);
    assert.equal(convertCalls[0].pdfPath, saved.source.storedFile);
    assert.match(readFileSync(saved.source.extraction.manifestFile, 'utf8'), /needs_review/);
    assert.match(readFileSync(saved.source.extraction.draftFile, 'utf8'), /draft_only/);
    assert.deepEqual(saved.source.extraction.summary.readyPages, []);
    assert.equal(saved.source.extraction.summary.masteryEvidence, false);

    const started = await request(baseUrl, '/api/start', { date: '2026-09-23' });
    assert.equal(started.currentPlan.availableMinutes, 45);
    assert.equal(started.currentPlan.allocations[0].title, '1장 읽기');
    assert.equal(started.setup.tasks.length, 2);
  }, { pdfConverter: fakePdfConverter(convertCalls) });
});

test('student setup reports failed extracted pages without making any page ready', async () => {
  const convertCalls = [];
  await withOnboardingServer(async ({ baseUrl }) => {
    const form = new FormData();
    form.append('pdf', new Blob([Buffer.from('%PDF-1.7\r\n%%EOF\r\n')], { type: 'application/pdf' }), 'sample.pdf');
    form.append('title', '학생 자료');
    form.append('dailyMinutes', '45');
    form.append('weeklyMinutes', '120');
    form.append('pageStart', '1');
    form.append('pageEnd', '2');
    form.append('tasks', '1장 읽기 | 40 | new');
    const response = await fetch(`${baseUrl}/api/setup`, { method: 'POST', body: form });
    const data = await response.json();
    assert.equal(response.status, 200, data.error);
    assert.equal(data.setup.source.extractionStatus, 'failed');
    assert.deepEqual(data.setup.source.pages, [
      { pdfPageIndex: 1, status: 'needs_review', reviewRequired: true },
      { pdfPageIndex: 2, status: 'failed', reviewRequired: true },
    ]);
    assert.deepEqual(convertCalls[0].selectedPages, [1, 2]);
  }, { pdfConverter: fakePdfConverter(convertCalls, { failedPages: [2] }) });
});

test('student setup rejects non-PDF uploads without changing the plan source', async () => {
  await withOnboardingServer(async ({ baseUrl }) => {
    const form = new FormData();
    form.append('pdf', new Blob([Buffer.from('not a pdf')], { type: 'text/plain' }), 'notes.txt');
    form.append('title', '학생 자료');
    form.append('dailyMinutes', '45');
    form.append('weeklyMinutes', '120');
    form.append('pageStart', '1');
    form.append('pageEnd', '1');
    form.append('tasks', '1장 읽기 | 40 | new');
    const response = await fetch(`${baseUrl}/api/setup`, { method: 'POST', body: form });
    const data = await response.json();
    assert.equal(response.status, 400);
    assert.match(data.error, /PDF/);
    const status = await request(baseUrl, '/api/status');
    assert.equal(status.setup.configured, false);
    assert.equal(status.planSource, 'synthetic_demo');
  });
});

test('student setup rejects descending or too-wide page ranges before extraction', async () => {
  const convertCalls = [];
  await withOnboardingServer(async ({ baseUrl }) => {
    const form = new FormData();
    form.append('pdf', new Blob([Buffer.from('%PDF-1.7\r\n%%EOF\r\n')], { type: 'application/pdf' }), 'sample.pdf');
    form.append('title', '학생 자료');
    form.append('dailyMinutes', '45');
    form.append('weeklyMinutes', '120');
    form.append('pageStart', '3');
    form.append('pageEnd', '1');
    form.append('tasks', '1장 읽기 | 40 | new');
    const response = await fetch(`${baseUrl}/api/setup`, { method: 'POST', body: form });
    const data = await response.json();
    assert.equal(response.status, 400);
    assert.match(data.error, /끝 페이지/);
    assert.equal(convertCalls.length, 0);
  }, { pdfConverter: fakePdfConverter(convertCalls) });
});

test('student setup removes a newly saved PDF when extraction fails', async () => {
  await withOnboardingServer(async ({ baseUrl, configFile, sourceDir }) => {
    const form = new FormData();
    form.append('pdf', new Blob([Buffer.from('%PDF-1.7\r\n%%EOF\r\n')], { type: 'application/pdf' }), 'sample.pdf');
    form.append('title', '학생 자료');
    form.append('dailyMinutes', '45');
    form.append('weeklyMinutes', '120');
    form.append('pageStart', '1');
    form.append('pageEnd', '2');
    form.append('tasks', '1장 읽기 | 40 | new');
    const response = await fetch(`${baseUrl}/api/setup`, { method: 'POST', body: form });
    const data = await response.json();
    assert.equal(response.status, 400);
    assert.match(data.error, /page outside PDF/);
    assert.equal(existsSync(configFile), false);
    assert.deepEqual(existsSync(sourceDir) ? readdirSync(sourceDir) : [], []);
  }, { pdfConverter: () => {
    throw new Error('PDF extraction failed: page outside PDF');
  } });
});

test('student setup archives a demo plan and starts the real setup with empty progress', async () => {
  const convertCalls = [];
  await withOnboardingServer(async ({ baseUrl, archiveDir }) => {
    const demo = await request(baseUrl, '/api/start', { date: '2026-09-23' });
    assert.equal(demo.currentPlan.planVersion, 1);
    assert.equal(demo.eventCount, 1);

    const setupResponse = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      body: setupForm({ tasks: '실제 1장 | 40 | 새 내용' }),
    });
    const setupStatus = await setupResponse.json();
    assert.equal(setupResponse.status, 200, setupStatus.error);
    assert.equal(setupStatus.currentPlan, null);
    assert.equal(setupStatus.eventCount, 0);
    assert.equal(setupStatus.confirmedProgressMinutes, 0);
    assert.match(setupStatus.setup.archiveFile, /study-web-/);
    assert.equal(existsSync(setupStatus.setup.archiveFile), true);
    assert.deepEqual(readdirSync(archiveDir), [basename(setupStatus.setup.archiveFile)]);
    assert.equal(JSON.parse(readFileSync(setupStatus.setup.archiveFile, 'utf8')).events.length, 1);

    const real = await request(baseUrl, '/api/start', { date: '2026-09-23' });
    assert.equal(real.currentPlan.planVersion, 1);
    assert.equal(real.currentPlan.allocations[0].title, '실제 1장');
    assert.equal(real.eventCount, 1);
    assert.equal(real.confirmedProgressMinutes, 0);
  }, { pdfConverter: fakePdfConverter(convertCalls) });
});

test('replacing an existing setup archives old progress and uses distinct task ids', async () => {
  const convertCalls = [];
  await withOnboardingServer(async ({ baseUrl }) => {
    let response = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      body: setupForm({ title: '첫 자료', tasks: '첫 자료 과업 | 40 | 새 내용' }),
    });
    assert.equal(response.status, 200, (await response.clone().json()).error);
    const firstStarted = await request(baseUrl, '/api/start', { date: '2026-09-23' });
    const firstTaskId = firstStarted.recommendedAction.taskId;
    await request(baseUrl, '/api/progress', { taskId: firstTaskId, completedMinutes: 10 });
    const progressed = await request(baseUrl, '/api/status');
    assert.equal(progressed.confirmedProgressMinutes, 10);

    response = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      body: setupForm({ title: '둘째 자료', tasks: '둘째 자료 과업 | 30 | 새 내용' }),
    });
    const replaced = await response.json();
    assert.equal(response.status, 200, replaced.error);
    assert.equal(replaced.currentPlan, null);
    assert.equal(replaced.confirmedProgressMinutes, 0);
    assert.equal(replaced.eventCount, 0);
    assert.equal(existsSync(replaced.setup.archiveFile), true);
    const archived = JSON.parse(readFileSync(replaced.setup.archiveFile, 'utf8'));
    assert.equal(archived.events.some(event => event.type === 'task_progress_recorded' && event.completedMinutes === 10), true);

    const secondStarted = await request(baseUrl, '/api/start', { date: '2026-09-23' });
    assert.equal(secondStarted.currentPlan.allocations[0].title, '둘째 자료 과업');
    assert.notEqual(secondStarted.recommendedAction.taskId, firstTaskId);
    assert.equal(secondStarted.confirmedProgressMinutes, 0);
    assert.deepEqual(secondStarted.progress, []);
  }, { pdfConverter: fakePdfConverter(convertCalls) });
});

test('failed replacement extraction keeps the previous setup and current plan', async () => {
  const convertCalls = [];
  await withOnboardingServer(async ({ baseUrl, storeFile, configFile }) => {
    let response = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      body: setupForm({ title: '첫 자료', tasks: '첫 자료 과업 | 40 | 새 내용' }),
    });
    assert.equal(response.status, 200, (await response.clone().json()).error);
    const started = await request(baseUrl, '/api/start', { date: '2026-09-23' });
    const beforeConfig = readFileSync(configFile, 'utf8');
    const beforeStore = readFileSync(storeFile, 'utf8');

    response = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      body: setupForm({ title: '실패 자료', tasks: '실패 과업 | 40 | 새 내용', pageStart: '1', pageEnd: '2' }),
    });
    const failed = await response.json();
    assert.equal(response.status, 400);
    assert.match(failed.error, /page outside PDF/);
    assert.equal(readFileSync(configFile, 'utf8'), beforeConfig);
    assert.equal(readFileSync(storeFile, 'utf8'), beforeStore);

    const status = await request(baseUrl, '/api/status');
    assert.equal(status.setup.title, '첫 자료');
    assert.equal(status.currentPlan.planVersion, started.currentPlan.planVersion);
    assert.equal(status.currentPlan.allocations[0].title, '첫 자료 과업');
    assert.equal(status.eventCount, 1);
  }, { pdfConverter: (input) => {
    if (input.title === '실패 자료') throw new Error('PDF extraction failed: page outside PDF');
    return fakePdfConverter(convertCalls)(input);
  } });
});

test('setup install failure restores the current store and removes new artifacts', async () => {
  const convertCalls = [];
  await withOnboardingServer(async ({ baseUrl, storeFile, sourceDir, draftDir, archiveDir, journalFile }) => {
    await request(baseUrl, '/api/start', { date: '2026-09-23' });
    const beforeStore = readFileSync(storeFile, 'utf8');
    mkdirSync(journalFile, { recursive: true });

    const response = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      body: setupForm({ title: '쓰기 실패 자료', tasks: '쓰기 실패 과업 | 40 | 새 내용' }),
    });
    const data = await response.json();
    assert.equal(response.status, 400);
    assert.match(data.error, /EEXIST|EISDIR|EPERM|directory|디렉터리|Cannot/);
    assert.equal(readFileSync(storeFile, 'utf8'), beforeStore);
    assert.deepEqual(existsSync(archiveDir) ? readdirSync(archiveDir) : [], []);
    assert.deepEqual(existsSync(sourceDir) ? readdirSync(sourceDir) : [], []);
    assert.deepEqual(existsSync(draftDir) ? readdirSync(draftDir) : [], []);
  }, { pdfConverter: fakePdfConverter(convertCalls) });
});

test('journal creation failure keeps the existing setup and store untouched', async () => {
  const convertCalls = [];
  await withOnboardingServer(async ({ baseUrl, storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile }) => {
    let response = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      body: setupForm({ title: '기존 자료', tasks: '기존 과업 | 40 | 새 내용' }),
    });
    assert.equal(response.status, 200, (await response.clone().json()).error);
    await request(baseUrl, '/api/start', { date: '2026-09-23' });
    const beforeSetup = readFileSync(configFile, 'utf8');
    const beforeStore = readFileSync(storeFile, 'utf8');
    mkdirSync(journalFile, { recursive: true });

    response = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      body: setupForm({ title: '실패 자료', tasks: '실패 과업 | 40 | 새 내용' }),
    });
    const data = await response.json();
    assert.equal(response.status, 400);
    assert.match(data.error, /EEXIST|EISDIR|EPERM|directory|디렉터리|Cannot/);
    assert.equal(readFileSync(configFile, 'utf8'), beforeSetup);
    assert.equal(readFileSync(storeFile, 'utf8'), beforeStore);
    assert.deepEqual(existsSync(archiveDir) ? readdirSync(archiveDir) : [], []);
    assert.equal(readdirSync(sourceDir).length, 1);
    assert.equal(readdirSync(draftDir).length, 2);
    const status = await request(baseUrl, '/api/status');
    assert.equal(status.setup.title, '기존 자료');
    assert.equal(status.currentPlan.allocations[0].title, '기존 과업');
  }, { pdfConverter: fakePdfConverter(convertCalls) });
});

test('startup journal recovery restores previous setup and store after an interrupted transition', async () => {
  const convertCalls = [];
  await withOnboardingServer(async ({ baseUrl, storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile, server }) => {
    let response = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      body: setupForm({ title: '기존 자료', tasks: '기존 과업 | 40 | 새 내용' }),
    });
    assert.equal(response.status, 200, (await response.clone().json()).error);
    await request(baseUrl, '/api/start', { date: '2026-09-23' });
    await new Promise(resolve => server.close(resolve));

    const newSetupId = setupId();
    const newArtifacts = validArtifacts(sourceDir, draftDir);
    writeFileSync(newArtifacts.storedFile, '%PDF-1.7\n%%EOF\n');
    writeFileSync(newArtifacts.manifestFile, '{}\n');
    writeFileSync(newArtifacts.draftFile, 'draft\n');
    const setupTemp = validSetupTemp(configFile);
    writeFileSync(setupTemp, JSON.stringify(fakeSetup(newSetupId, '새 자료', newArtifacts)));
    const previousSetupArchiveFile = validSetupArchive(archiveDir);
    const storeArchiveFile = validStoreArchive(archiveDir);
    mkdirSync(archiveDir, { recursive: true });
    renameSync(configFile, previousSetupArchiveFile);
    renameSync(storeFile, storeArchiveFile);
    writeTransitionJournal({ journalFile, configFile, setupTemp, storeFile, storeArchiveFile,
      previousSetupArchiveFile, newSetupId, artifacts: newArtifacts });

    createServer({ storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile,
      pdfConverter: fakePdfConverter(convertCalls) });
    assert.equal(existsSync(journalFile), false);
    assert.equal(existsSync(setupTemp), false);
    assert.equal(existsSync(newArtifacts.storedFile), false);
    assert.equal(existsSync(newArtifacts.manifestFile), false);
    assert.equal(existsSync(newArtifacts.draftFile), false);
    assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).title, '기존 자료');
    assert.equal(readStore(storeFile).currentPlan.allocations[0].title, '기존 과업');
    assert.equal(existsSync(previousSetupArchiveFile), false);
    assert.equal(existsSync(storeArchiveFile), false);
  }, { pdfConverter: fakePdfConverter(convertCalls) });
});

test('startup journal recovery keeps the current setup when interrupted before setup archive move', async () => {
  const convertCalls = [];
  await withOnboardingServer(async ({ baseUrl, storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile, server }) => {
    let response = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      body: setupForm({ title: '기존 자료', tasks: '기존 과업 | 40 | 새 내용' }),
    });
    assert.equal(response.status, 200, (await response.clone().json()).error);
    await request(baseUrl, '/api/start', { date: '2026-09-23' });
    await new Promise(resolve => server.close(resolve));

    const newSetupId = setupId();
    const newArtifacts = validArtifacts(sourceDir, draftDir);
    writeFileSync(newArtifacts.storedFile, '%PDF-1.7\n%%EOF\n');
    writeFileSync(newArtifacts.manifestFile, '{}\n');
    writeFileSync(newArtifacts.draftFile, 'draft\n');
    const setupTemp = validSetupTemp(configFile);
    writeFileSync(setupTemp, JSON.stringify(fakeSetup(newSetupId, '새 자료', newArtifacts)));
    writeTransitionJournal({ journalFile, configFile, setupTemp, storeFile, storeArchiveFile: null,
      previousSetupArchiveFile: null, newSetupId, artifacts: newArtifacts });

    createServer({ storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile,
      pdfConverter: fakePdfConverter(convertCalls) });
    assert.equal(existsSync(journalFile), false);
    assert.equal(existsSync(setupTemp), false);
    assert.equal(existsSync(newArtifacts.storedFile), false);
    assert.equal(existsSync(newArtifacts.manifestFile), false);
    assert.equal(existsSync(newArtifacts.draftFile), false);
    assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).title, '기존 자료');
    assert.equal(readStore(storeFile).currentPlan.allocations[0].title, '기존 과업');
  }, { pdfConverter: fakePdfConverter(convertCalls) });
});

test('polluted transition journal is ignored without touching referenced external files', async () => {
  const convertCalls = [];
  await withOnboardingServer(async ({ baseUrl, storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile, server }) => {
    let response = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      body: setupForm({ title: '기존 자료', tasks: '기존 과업 | 40 | 새 내용' }),
    });
    assert.equal(response.status, 200, (await response.clone().json()).error);
    await request(baseUrl, '/api/start', { date: '2026-09-23' });
    await new Promise(resolve => server.close(resolve));
    const beforeSetup = readFileSync(configFile, 'utf8');
    const beforeStore = readFileSync(storeFile, 'utf8');
    const externalFile = join(tmpdir(), `challenge-master-external-${randomUUID()}.txt`);
    writeFileSync(externalFile, 'external sentinel');
    try {
      writeFileSync(journalFile, JSON.stringify({
        schemaVersion: 1,
        journalFile: externalFile,
        newSetupId: setupId(),
        configFile,
        setupTemp: externalFile,
        storeFile,
        storeArchiveFile: externalFile,
        previousSetupArchiveFile: externalFile,
        newArtifacts: {
          storedFile: externalFile,
          manifestFile: externalFile,
          draftFile: externalFile,
        },
      }, null, 2));

      createServer({ storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile,
        pdfConverter: fakePdfConverter(convertCalls) });
      assert.equal(readFileSync(externalFile, 'utf8'), 'external sentinel');
      assert.equal(readFileSync(configFile, 'utf8'), beforeSetup);
      assert.equal(readFileSync(storeFile, 'utf8'), beforeStore);
      assert.equal(existsSync(journalFile), true);
    } finally {
      rmSync(externalFile, { force: true });
    }
  }, { pdfConverter: fakePdfConverter(convertCalls) });
});

test('nested or junction artifact paths in a transition journal are ignored', async () => {
  const convertCalls = [];
  await withOnboardingServer(async ({ baseUrl, storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile, server, dir }) => {
    let response = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      body: setupForm({ title: '기존 자료', tasks: '기존 과업 | 40 | 새 내용' }),
    });
    assert.equal(response.status, 200, (await response.clone().json()).error);
    await request(baseUrl, '/api/start', { date: '2026-09-23' });
    await new Promise(resolve => server.close(resolve));
    const beforeSetup = readFileSync(configFile, 'utf8');
    const beforeStore = readFileSync(storeFile, 'utf8');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(draftDir, { recursive: true });
    const nestedSource = join(sourceDir, 'nested');
    const junctionTarget = join(dir, 'junction-target');
    mkdirSync(junctionTarget, { recursive: true });
    try {
      symlinkSync(junctionTarget, nestedSource, 'junction');
    } catch {
      mkdirSync(nestedSource, { recursive: true });
    }
    const nestedDraft = join(draftDir, 'nested');
    mkdirSync(nestedDraft, { recursive: true });
    const sourceId = `local-pdf-${randomUUID()}`;
    const nestedArtifacts = {
      storedFile: join(nestedSource, `${randomUUID()}.pdf`),
      manifestFile: join(nestedDraft, `${sourceId}.manifest.json`),
      draftFile: join(nestedDraft, `${sourceId}.draft.md`),
    };
    writeFileSync(nestedArtifacts.storedFile, '%PDF-1.7\n%%EOF\n');
    writeFileSync(nestedArtifacts.manifestFile, '{}\n');
    writeFileSync(nestedArtifacts.draftFile, 'draft\n');
    const setupTemp = validSetupTemp(configFile);
    writeFileSync(setupTemp, JSON.stringify(fakeSetup(setupId(), '새 자료', validArtifacts(sourceDir, draftDir))));
    writeTransitionJournal({ journalFile, configFile, setupTemp, storeFile, storeArchiveFile: null,
      previousSetupArchiveFile: null, newSetupId: setupId(), artifacts: nestedArtifacts });

    createServer({ storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile,
      pdfConverter: fakePdfConverter(convertCalls) });
    assert.equal(readFileSync(configFile, 'utf8'), beforeSetup);
    assert.equal(readFileSync(storeFile, 'utf8'), beforeStore);
    assert.equal(readFileSync(nestedArtifacts.storedFile, 'utf8'), '%PDF-1.7\n%%EOF\n');
    assert.equal(readFileSync(nestedArtifacts.manifestFile, 'utf8'), '{}\n');
    assert.equal(readFileSync(nestedArtifacts.draftFile, 'utf8'), 'draft\n');
    assert.equal(existsSync(journalFile), true);
    assert.equal(existsSync(setupTemp), true);
  }, { pdfConverter: fakePdfConverter(convertCalls) });
});

test('transition recovery preserves new artifacts when setup temp cannot be parsed', async () => {
  const convertCalls = [];
  await withOnboardingServer(async ({ storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile, server }) => {
    await new Promise(resolve => server.close(resolve));
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(draftDir, { recursive: true });
    const newSetupId = setupId();
    const newArtifacts = validArtifacts(sourceDir, draftDir);
    writeFileSync(newArtifacts.storedFile, '%PDF-1.7\n%%EOF\n');
    writeFileSync(newArtifacts.manifestFile, '{}\n');
    writeFileSync(newArtifacts.draftFile, 'draft\n');
    writeFileSync(configFile, JSON.stringify(fakeSetup(setupId(), '기존 자료', validArtifacts(sourceDir, draftDir))));
    const setupTemp = validSetupTemp(configFile);
    writeFileSync(setupTemp, '{not json');
    writeTransitionJournal({ journalFile, configFile, setupTemp, storeFile, storeArchiveFile: null,
      previousSetupArchiveFile: null, newSetupId, artifacts: newArtifacts });

    createServer({ storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile,
      pdfConverter: fakePdfConverter(convertCalls) });
    assert.equal(existsSync(journalFile), false);
    assert.equal(existsSync(setupTemp), false);
    assert.equal(readFileSync(newArtifacts.storedFile, 'utf8'), '%PDF-1.7\n%%EOF\n');
    assert.equal(readFileSync(newArtifacts.manifestFile, 'utf8'), '{}\n');
    assert.equal(readFileSync(newArtifacts.draftFile, 'utf8'), 'draft\n');
  }, { pdfConverter: fakePdfConverter(convertCalls) });
});

test('transition recovery preserves new artifacts when the current setup cannot be parsed', async () => {
  const convertCalls = [];
  await withOnboardingServer(async ({ storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile, server }) => {
    await new Promise(resolve => server.close(resolve));
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(draftDir, { recursive: true });
    const newSetupId = setupId();
    const newArtifacts = validArtifacts(sourceDir, draftDir);
    writeFileSync(newArtifacts.storedFile, '%PDF-1.7\n%%EOF\n');
    writeFileSync(newArtifacts.manifestFile, '{}\n');
    writeFileSync(newArtifacts.draftFile, 'draft\n');
    writeFileSync(configFile, '{not json');
    const setupTemp = validSetupTemp(configFile);
    writeFileSync(setupTemp, JSON.stringify(fakeSetup(newSetupId, '새 자료', newArtifacts)));
    writeTransitionJournal({ journalFile, configFile, setupTemp, storeFile, storeArchiveFile: null,
      previousSetupArchiveFile: null, newSetupId, artifacts: newArtifacts });

    createServer({ storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile,
      pdfConverter: fakePdfConverter(convertCalls) });
    assert.equal(existsSync(journalFile), false);
    assert.equal(existsSync(setupTemp), false);
    assert.equal(readFileSync(configFile, 'utf8'), '{not json');
    assert.equal(readFileSync(newArtifacts.storedFile, 'utf8'), '%PDF-1.7\n%%EOF\n');
    assert.equal(readFileSync(newArtifacts.manifestFile, 'utf8'), '{}\n');
    assert.equal(readFileSync(newArtifacts.draftFile, 'utf8'), 'draft\n');
  }, { pdfConverter: fakePdfConverter(convertCalls) });
});

test('polluted transition journal does not delete valid UUID paths referenced by the current setup', async () => {
  const convertCalls = [];
  await withOnboardingServer(async ({ storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile, server }) => {
    await new Promise(resolve => server.close(resolve));
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(draftDir, { recursive: true });
    const existingArtifacts = validArtifacts(sourceDir, draftDir);
    writeFileSync(existingArtifacts.storedFile, '%PDF-1.7\n%%EOF\n');
    writeFileSync(existingArtifacts.manifestFile, '{}\n');
    writeFileSync(existingArtifacts.draftFile, 'draft\n');
    writeFileSync(configFile, JSON.stringify(fakeSetup(setupId(), '기존 자료', existingArtifacts)));
    const newSetupId = setupId();
    const setupTemp = validSetupTemp(configFile);
    writeFileSync(setupTemp, JSON.stringify(fakeSetup(newSetupId, '새 자료', existingArtifacts)));
    writeTransitionJournal({ journalFile, configFile, setupTemp, storeFile, storeArchiveFile: null,
      previousSetupArchiveFile: null, newSetupId, artifacts: existingArtifacts });

    createServer({ storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile,
      pdfConverter: fakePdfConverter(convertCalls) });
    assert.equal(existsSync(journalFile), false);
    assert.equal(existsSync(setupTemp), false);
    assert.equal(readFileSync(existingArtifacts.storedFile, 'utf8'), '%PDF-1.7\n%%EOF\n');
    assert.equal(readFileSync(existingArtifacts.manifestFile, 'utf8'), '{}\n');
    assert.equal(readFileSync(existingArtifacts.draftFile, 'utf8'), 'draft\n');
    assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).title, '기존 자료');
  }, { pdfConverter: fakePdfConverter(convertCalls) });
});

test('transition recovery does not delete artifact paths referenced by archived previous setup', async () => {
  const convertCalls = [];
  await withOnboardingServer(async ({ storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile, server }) => {
    await new Promise(resolve => server.close(resolve));
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(draftDir, { recursive: true });
    mkdirSync(archiveDir, { recursive: true });
    const previousArtifacts = validArtifacts(sourceDir, draftDir);
    writeFileSync(previousArtifacts.storedFile, '%PDF-1.7\n%%EOF\n');
    writeFileSync(previousArtifacts.manifestFile, '{}\n');
    writeFileSync(previousArtifacts.draftFile, 'draft\n');
    const previousSetupArchiveFile = validSetupArchive(archiveDir);
    writeFileSync(previousSetupArchiveFile, JSON.stringify(fakeSetup(setupId(), '이전 자료', previousArtifacts)));
    const newSetupId = setupId();
    const setupTemp = validSetupTemp(configFile);
    writeFileSync(setupTemp, JSON.stringify(fakeSetup(newSetupId, '새 자료', previousArtifacts)));
    writeTransitionJournal({ journalFile, configFile, setupTemp, storeFile, storeArchiveFile: null,
      previousSetupArchiveFile, newSetupId, artifacts: previousArtifacts });

    createServer({ storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile,
      pdfConverter: fakePdfConverter(convertCalls) });
    assert.equal(existsSync(journalFile), false);
    assert.equal(existsSync(setupTemp), false);
    assert.equal(readFileSync(previousArtifacts.storedFile, 'utf8'), '%PDF-1.7\n%%EOF\n');
    assert.equal(readFileSync(previousArtifacts.manifestFile, 'utf8'), '{}\n');
    assert.equal(readFileSync(previousArtifacts.draftFile, 'utf8'), 'draft\n');
    assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).title, '이전 자료');
  }, { pdfConverter: fakePdfConverter(convertCalls) });
});

test('startup journal recovery completes when the new setup was already atomically installed', async () => {
  const convertCalls = [];
  await withOnboardingServer(async ({ storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile, server }) => {
    await new Promise(resolve => server.close(resolve));
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(draftDir, { recursive: true });
    mkdirSync(archiveDir, { recursive: true });
    const newSetupId = setupId();
    const newArtifacts = validArtifacts(sourceDir, draftDir);
    writeFileSync(newArtifacts.storedFile, '%PDF-1.7\n%%EOF\n');
    writeFileSync(newArtifacts.manifestFile, '{}\n');
    writeFileSync(newArtifacts.draftFile, 'draft\n');
    writeFileSync(configFile, JSON.stringify(fakeSetup(newSetupId, '새 자료', newArtifacts)));
    const setupTemp = validSetupTemp(configFile);
    const previousSetupArchiveFile = validSetupArchive(archiveDir);
    const storeArchiveFile = validStoreArchive(archiveDir);
    writeFileSync(previousSetupArchiveFile, JSON.stringify(fakeSetup(setupId(), '이전 자료')));
    writeFileSync(storeArchiveFile, JSON.stringify({ schemaVersion: 1, events: [] }));
    writeTransitionJournal({ journalFile, configFile, setupTemp, storeFile, storeArchiveFile,
      previousSetupArchiveFile, newSetupId, artifacts: newArtifacts });

    createServer({ storeFile, configFile, sourceDir, draftDir, archiveDir, journalFile,
      pdfConverter: fakePdfConverter(convertCalls) });
    assert.equal(existsSync(journalFile), false);
    assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).title, '새 자료');
    assert.equal(existsSync(newArtifacts.storedFile), true);
    assert.equal(existsSync(newArtifacts.manifestFile), true);
    assert.equal(existsSync(newArtifacts.draftFile), true);
    assert.equal(existsSync(previousSetupArchiveFile), true);
    assert.equal(existsSync(storeArchiveFile), true);
  }, { pdfConverter: fakePdfConverter(convertCalls) });
});

test('fixed input mode rejects PDF setup and keeps the explicit local input source', async () => {
  await withServer(async ({ baseUrl }) => {
    const status = await request(baseUrl, '/api/status');
    assert.equal(status.planSource, 'local_file:C:\\자료\\plan.json');
    const response = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      body: setupForm(),
    });
    const data = await response.json();
    assert.equal(response.status, 400);
    assert.match(data.error, /고정 입력 모드/);
    const after = await request(baseUrl, '/api/status');
    assert.equal(after.setup.configured, false);
    assert.equal(after.planSource, 'local_file:C:\\자료\\plan.json');
  }, planInput, { planSource: 'local_file:C:\\자료\\plan.json' });
});

test('student setup rejects partial integer strings before extraction', async () => {
  for (const [field, value] of [['dailyMinutes', '40abc'], ['weeklyMinutes', '1e3'], ['pageStart', '2.5']]) {
    const convertCalls = [];
    await withOnboardingServer(async ({ baseUrl, sourceDir }) => {
      const form = setupForm();
      form.set(field, value);
      const response = await fetch(`${baseUrl}/api/setup`, { method: 'POST', body: form });
      const data = await response.json();
      assert.equal(response.status, 400);
      assert.match(data.error, /정수/);
      assert.equal(convertCalls.length, 0);
      assert.deepEqual(existsSync(sourceDir) ? readdirSync(sourceDir) : [], []);
    }, { pdfConverter: fakePdfConverter(convertCalls) });
  }
});

test('quit endpoint is localhost guarded and closes the local server', async () => {
  await withOnboardingServer(async ({ baseUrl, server }) => {
    const rejected = await rawRequest(baseUrl, '/api/quit', {
      headers: { origin: 'http://example.test', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(rejected.status, 403);
    assert.equal(server.listening, true);

    const closed = new Promise(resolve => server.once('close', resolve));
    const accepted = await rawRequest(baseUrl, '/api/quit', {
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).ok, true);
    await closed;
    assert.equal(server.listening, false);
  });
});
