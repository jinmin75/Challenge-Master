// Web version (D022): the same request rules as the local app, with records kept only in this browser's
// IndexedDB. Nothing is sent anywhere; the PDF is read in the page and only the extracted text is kept.
// Loaded by app.js only when the page is built with data-mode="browser" (scripts/build-web.mjs).
import { applyEvent, emptyState } from './src/events.mjs';
import { calendarFor, eventBuilder, isPdfBytes, localDate, parseSetupFields, planInputFromSetup, safeOriginalName,
  statusFor, studentError, studentPdfError, textlessPages, writePaths, writeResponse } from './src/app-core.mjs';
import { MAX_PDF_BYTES, manifestFromExtraction } from './src/pdf-core.mjs';
import { readPdfPages } from './src/pdf-read.mjs';
import { approveSummary, candidateLog, completeBlocker, decideLog, lockSession, MAX_LOGS, MAX_SESSIONS, noteItems, retakeSession, reviewCycle,
  reviewDateBlocker, reviewTasks, saveLog, saveSession, sourcePages } from './src/study-core.mjs';
import { buildWikiExport, checkWikiExport } from './src/wiki-export.mjs';
import { activeConsent, buildRequest, MAX_AI_REVIEWS, newAiReview, newConsent, parseCandidates,
  parseCauseSuggestion, PURPOSES } from './src/ai-bridge.mjs';

export { PURPOSES };

const DB_NAME = 'challenge-master';
const STORE = 'kv';
const BACKUP_KIND = 'challenge-master-backup';
const RECORD_KEYS = ['setup', 'events', 'draft', 'archives', 'meta', 'study'];
const channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('challenge-master') : null;

// English store messages that can reach students outside the calendar (the local app shows them as they are).
const extraMessages = [
  ['Confirmed progress exceeds plan allocation', '오늘 배정된 분보다 많이 기록할 수 없습니다.'],
  ['Confirmed progress exceeds the remaining task estimate', '그 과업의 남은 분량보다 많이 기록할 수 없습니다.'],
];

function toStudentError(error) {
  const match = extraMessages.find(([english]) => error.message.includes(english));
  return match ? new Error(match[1], { cause: error }) : studentError(error);
}

let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    let request;
    try { request = indexedDB.open(DB_NAME, 1); } catch (error) { reject(storageError(error)); return; }
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(storageError(request.error));
  });
  return dbPromise;
}

function storageError(cause) {
  return new Error('이 브라우저에 기록을 저장할 수 없습니다. 시크릿(개인정보 보호) 창이라면 일반 창에서 열어 주세요.', { cause });
}

// Reads `keys`, then runs work(values, put) inside the same transaction. work must stay synchronous:
// an await would let the transaction commit before the write. put(key, undefined) deletes the key.
async function transact(keys, mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const values = {};
    let pending = keys.length;
    let result;
    let failure = null;
    const put = (key, value) => (value === undefined ? store.delete(key) : store.put(value, key));
    const run = () => {
      try { result = work(values, put); } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure ?? storageError(tx.error));
    if (pending === 0) { run(); return; }
    for (const key of keys) {
      const request = store.get(key);
      request.onsuccess = () => {
        values[key] = request.result;
        pending -= 1;
        if (pending === 0) run();
      };
    }
  });
}

function replay(events = []) {
  return events.reduce(applyEvent, emptyState());
}

function notify() {
  channel?.postMessage('changed');
}

export function onChange(listener) {
  channel?.addEventListener('message', listener);
}

let demoInput;
async function runtimeFor(setup, state, study) {
  let runtime;
  if (setup) {
    runtime = { input: planInputFromSetup(setup), source: `local_setup:${setup.source.originalName}`, setup, storage: 'browser' };
  } else {
    demoInput ??= await (await fetch(new URL('./fixtures/synthetic-plan.json', import.meta.url))).json();
    runtime = { input: structuredClone(demoInput), source: 'synthetic_demo', setup: null, storage: 'browser' };
  }
  // A-3: 오답 reviews whose date has come join the plan as review tasks (within the review share, not extra time).
  runtime.input.tasks = [...runtime.input.tasks,
    ...reviewTasks({ sessions: study?.sessions ?? [], state, today: localDate() })];
  return runtime;
}

// Same paths and answers as the local app's /api routes, so app.js and calendar.js run unchanged.
export async function request(path, body) {
  const url = new URL(path, 'https://challenge-master.invalid');
  const saved = await transact(['setup', 'events', 'study'], 'readonly', values => values);
  const runtime = await runtimeFor(saved.setup, replay(saved.events), saved.study);
  if (!body) {
    const state = replay(saved.events);
    if (url.pathname === '/api/status') return statusFor(state, runtime);
    if (url.pathname === '/api/calendar') {
      return calendarFor(state, url.searchParams.get('month') ?? localDate().slice(0, 7), runtime);
    }
    throw new Error('지원하지 않는 요청입니다.');
  }
  if (!writePaths.has(url.pathname)) throw new Error('지원하지 않는 요청입니다.');
  try {
    const build = eventBuilder(url.pathname, body, runtime);
    const setupId = saved.setup?.id ?? null;
    const state = await transact(['setup', 'events'], 'readwrite', (values, put) => {
      if ((values.setup?.id ?? null) !== setupId) {
        throw new Error('다른 창에서 자료를 바꿨습니다. 이 창을 새로고침해 주세요.');
      }
      const before = replay(values.events);
      const after = applyEvent(before, build(structuredClone(before)));
      if (after.events.length !== before.events.length) put('events', after.events);
      return after;
    });
    notify();
    return writeResponse(url.pathname, body, state, runtime);
  } catch (error) {
    throw toStudentError(error);
  }
}

let pdfjsPromise;
async function extractPages(bytes, pages) {
  const base = new URL('./vendor/pdfjs/', import.meta.url);
  pdfjsPromise ??= import('./vendor/pdfjs/pdf.min.mjs').then(pdfjs => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', base).href;
    return pdfjs;
  });
  return readPdfPages(await pdfjsPromise, {
    data: bytes, pages,
    cMapUrl: new URL('cmaps/', base).href,
    standardFontDataUrl: new URL('standard_fonts/', base).href,
    wasmUrl: new URL('wasm/', base).href,
  });
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch { /* Not supported (e.g. Safari 16 or earlier); backups remain the safeguard. */ }
}

// Registration: read the PDF in the page, keep the extracted text, and start an empty record.
// A previous setup and its records move to `archives` in this browser, like the local app's archive files.
export async function setup(form) {
  const file = form.get('pdf');
  if (!file || typeof file === 'string' || !file.name || file.size === 0) throw new Error('PDF 파일을 선택해 주세요.');
  const originalName = safeOriginalName(file.name);
  if (file.size > MAX_PDF_BYTES) throw new Error('PDF 파일이 너무 큽니다.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!originalName.toLowerCase().endsWith('.pdf') || !isPdfBytes(bytes)) throw new Error('PDF 파일만 등록할 수 있습니다.');
  const { title, dailyMinutes, weeklyMinutes, tasks, selectedPages } =
    parseSetupFields(name => String(form.get(name) ?? '').trim());
  const sourceId = `local-pdf-${crypto.randomUUID()}`;
  let extraction;
  try {
    const sourceHash = hex(await crypto.subtle.digest('SHA-256', bytes));
    const extracted = await extractPages(bytes, selectedPages);
    extraction = manifestFromExtraction({ sourceId, sourceHash, title, edition: originalName, selectedPages, extracted });
  } catch (error) {
    throw new Error(studentPdfError(error.message), { cause: error });
  }
  const record = {
    schemaVersion: 1,
    id: `setup-${crypto.randomUUID()}`,
    title,
    dailyMinutes,
    weeklyMinutes,
    tasks,
    source: {
      originalName,
      sizeBytes: file.size,
      uploadedAt: new Date().toISOString(),
      selectedPages,
      extractionStatus: extraction.summary.failedPages.length > 0 ? 'failed' : 'needs_review',
      extraction: { summary: extraction.summary, textlessPages: textlessPages(extraction, selectedPages) },
    },
  };
  await transact(['setup', 'events', 'archives'], 'readwrite', (values, put) => {
    if (values.setup || (values.events?.length ?? 0) > 0) {
      const archives = values.archives ?? [];
      archives.push({ archivedAt: new Date().toISOString(), setup: values.setup ?? null, events: values.events ?? [] });
      record.archiveFile = `browser-archive-${archives.length}`;
      put('archives', archives);
    }
    put('setup', record);
    put('events', []);
    put('draft', { sourceId, manifest: extraction.manifest, draftMarkdown: extraction.draftMarkdown });
  });
  await requestPersistence();
  notify();
  return request('/api/status');
}

// ---- Backup, restore, and clearing (the learner manages their own records after the course) ----

export async function exportBackup() {
  const exportedAt = new Date().toISOString();
  const backup = await transact(['setup', 'events', 'draft', 'archives', 'meta', 'study'], 'readwrite', (values, put) => {
    put('meta', { ...(values.meta ?? {}), lastBackupAt: exportedAt });
    return {
      kind: BACKUP_KIND, schemaVersion: 1, exportedAt,
      setup: values.setup ?? null, events: values.events ?? [], draft: values.draft ?? null,
      archives: values.archives ?? [],
      study: values.study ?? null,
    };
  });
  return { fileName: `challenge-master-backup-${localDate()}.json`, text: JSON.stringify(backup) };
}

export async function importBackup(text) {
  let backup;
  try { backup = JSON.parse(text); } catch { throw new Error('백업 파일을 읽을 수 없습니다.'); }
  if (backup?.kind !== BACKUP_KIND || backup.schemaVersion !== 1 || !Array.isArray(backup.events) ||
      !Array.isArray(backup.archives ?? [])) {
    throw new Error('Challenge Master 백업 파일이 아닙니다.');
  }
  try {
    replay(backup.events);
    if (backup.setup) planInputFromSetup(backup.setup);
    if (backup.study != null && (!Array.isArray(backup.study.sessions) ||
        backup.study.sessions.some(item => typeof item?.id !== 'string' || typeof item?.question !== 'string') ||
        (backup.study.logs != null && (!Array.isArray(backup.study.logs) ||
          backup.study.logs.some(log => typeof log?.id !== 'string' || typeof log?.sessionId !== 'string'))))) {
      throw new Error('study records malformed');
    }
  } catch (error) {
    throw new Error('백업 파일의 기록이 손상되어 불러올 수 없습니다.', { cause: error });
  }
  await transact([], 'readwrite', (_, put) => {
    put('setup', backup.setup ?? undefined);
    put('events', backup.events);
    put('draft', backup.draft ?? undefined);
    put('archives', backup.archives ?? []);
    put('study', backup.study ?? undefined);
    // The restored records exist in that backup file, so it counts as the latest backup.
    put('meta', typeof backup.exportedAt === 'string' ? { lastBackupAt: backup.exportedAt } : undefined);
  });
  await requestPersistence();
  notify();
  return request('/api/status');
}

export async function clearAll() {
  await transact([], 'readwrite', (_, put) => { for (const key of RECORD_KEYS) put(key, undefined); });
  notify();
  return request('/api/status');
}

// A-1 교재 보기: the registered PDF's extracted pages (null on the demo input).
export async function sourceView() {
  const values = await transact(['setup', 'draft'], 'readonly', saved => saved);
  return sourcePages(values);
}

// ---- A-2 학습실 records: one document { schemaVersion, sessions[] } under the key 'study' ----

function sessionsOf(values) {
  return values.study?.sessions ?? [];
}

function logsOf(values) {
  return values.study?.logs ?? [];
}

// Runs change(sessions, values, logs) on the stored study records in one transaction and stores what it returns.
// Sessions and learning logs share the one 'study' document; a change that returns no logs keeps them as they were.
async function changeSessions(keys, change) {
  const result = await transact(['study', ...keys], 'readwrite', (values, put) => {
    const { sessions, logs, value, extra } = change([...sessionsOf(values)], values, [...logsOf(values)]);
    put('study', { ...(values.study ?? {}), ...(extra ?? {}), schemaVersion: 1, sessions, logs: logs ?? logsOf(values) });
    return value;
  });
  notify();
  return result;
}

function findSession(sessions, id) {
  const index = sessions.findIndex(item => item.id === id);
  if (index < 0) throw new Error('학습 기록을 찾을 수 없습니다. 다른 창에서 지웠을 수 있습니다. 새로고침해 주세요.');
  return index;
}

export async function studySessions() {
  const values = await transact(['study'], 'readonly', saved => saved);
  return [...sessionsOf(values)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveStudySession(input) {
  const now = new Date().toISOString();
  return changeSessions(['events'], (sessions, values) => {
    const index = input.id ? findSession(sessions, input.id) : -1;
    // A review already in a plan keeps its date until it is done (the plan still holds that task).
    if (index >= 0 && input.reviewDate !== undefined && input.reviewDate !== sessions[index].reviewDate) {
      const blocker = reviewDateBlocker(sessions[index], replay(values.events), localDate());
      if (blocker) throw new Error(blocker);
    }
    if (index < 0 && sessions.length >= MAX_SESSIONS) throw new Error(`학습 기록은 ${MAX_SESSIONS}개까지 저장합니다.`);
    const saved = saveSession(index >= 0 ? sessions[index] : null, input, { id: crypto.randomUUID(), now });
    if (index >= 0) sessions[index] = saved;
    else sessions.push(saved);
    return { sessions, value: saved };
  });
}

// Step 3 starts: the evidence pages' text is copied from the registered source in the same transaction.
export async function lockStudySession(id) {
  const now = new Date().toISOString();
  return changeSessions(['setup', 'draft'], (sessions, values) => {
    const index = findSession(sessions, id);
    sessions[index] = lockSession(sessions[index], sourcePages(values), { now });
    return { sessions, value: sessions[index] };
  });
}

export async function retakeStudySession(id) {
  const now = new Date().toISOString();
  return changeSessions([], sessions => {
    if (sessions.length >= MAX_SESSIONS) throw new Error(`학습 기록은 ${MAX_SESSIONS}개까지 저장합니다.`);
    const retake = retakeSession(sessions[findSession(sessions, id)], { id: crypto.randomUUID(), now });
    sessions.push(retake);
    return { sessions, value: retake };
  });
}

// ---- A-3 오답노트 ----

export async function notesView() {
  const values = await transact(['study', 'events'], 'readonly', saved => saved);
  return noteItems({ sessions: sessionsOf(values), state: replay(values.events), today: localDate() });
}

// How a session's review stands, for the study room's review-date field.
export async function reviewInfo(id) {
  const values = await transact(['study', 'events'], 'readonly', saved => saved);
  const session = sessionsOf(values).find(item => item.id === id);
  if (!session) return { cycle: null, dateBlocker: null };
  const state = replay(values.events);
  return { cycle: reviewCycle(session, state, localDate()), dateBlocker: reviewDateBlocker(session, state, localDate()) };
}

// 「복습했어요」: a review in today's plan is recorded as study time on its plan task (the plan stays the record of
// time spent); a review that never entered a plan is marked done on the note. Either way the note keeps a history.
export async function completeReview(id) {
  const values = await transact(['study', 'events'], 'readonly', saved => saved);
  const session = sessionsOf(values).find(item => item.id === id);
  if (!session) throw new Error('학습 기록을 찾을 수 없습니다. 새로고침해 주세요.');
  const state = replay(values.events);
  const cycle = reviewCycle(session, state, localDate());
  const blocker = completeBlocker(cycle);
  if (blocker) throw new Error(blocker);
  if (cycle.inCurrentPlan) {
    const allocated = state.currentPlan.allocations.filter(item => item.taskId === cycle.taskId)
      .reduce((sum, item) => sum + item.minutes, 0);
    const recorded = state.progress.filter(item => item.taskId === cycle.taskId && item.planVersion === state.currentPlan.planVersion)
      .reduce((sum, item) => sum + item.completedMinutes, 0);
    const minutes = Math.min(allocated - recorded, cycle.minutes - cycle.credited);
    if (minutes > 0) await request('/api/progress', { requestId: crypto.randomUUID(), taskId: cycle.taskId, completedMinutes: minutes });
    // Today's plan held only part of the review time: the rest stays planned and the note is not done yet.
    if (cycle.credited + Math.max(minutes, 0) < cycle.minutes) return request('/api/status');
  }
  const now = new Date().toISOString();
  await changeSessions([], sessions => {
    const index = findSession(sessions, id);
    const reviews = sessions[index].reviews ?? [];
    if (!reviews.some(review => review.dueDate === cycle.date)) {
      sessions[index] = { ...sessions[index], reviews: [...reviews, { dueDate: cycle.date, doneAt: now }], updatedAt: now };
    }
    return { sessions, value: null };
  });
  return request('/api/status');
}

export async function deleteStudySession(id) {
  return changeSessions([], (sessions, _values, logs) => {
    sessions.splice(findSession(sessions, id), 1);
    // A record's learning logs go with it.
    return { sessions, logs: logs.filter(log => log.sessionId !== id), value: null };
  });
}

// ---- A-4 학습로그와 마무리 ----

export async function studyLogs(sessionId = null) {
  const values = await transact(['study'], 'readonly', saved => saved);
  return logsOf(values).filter(log => !sessionId || log.sessionId === sessionId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function saveStudyLog(input) {
  const now = new Date().toISOString();
  return changeSessions([], (sessions, _values, logs) => {
    const index = input.id ? logs.findIndex(log => log.id === input.id) : -1;
    if (input.id && index < 0) throw new Error('학습로그를 찾을 수 없습니다. 새로고침해 주세요.');
    const session = sessions[findSession(sessions, index >= 0 ? logs[index].sessionId : input.sessionId)];
    if (index < 0 && logs.length >= MAX_LOGS) throw new Error(`학습로그는 ${MAX_LOGS}개까지 저장합니다.`);
    const saved = saveLog(index >= 0 ? logs[index] : null, input, { id: crypto.randomUUID(), now, session });
    if (index >= 0) logs[index] = saved;
    else logs.push(saved);
    return { sessions, logs, value: saved };
  });
}

export async function deleteStudyLog(id) {
  return changeSessions([], (sessions, _values, logs) => {
    const index = logs.findIndex(log => log.id === id);
    if (index < 0) throw new Error('학습로그를 찾을 수 없습니다. 새로고침해 주세요.');
    logs.splice(index, 1);
    return { sessions, logs, value: null };
  });
}

export async function approveStudySummary(sessionId, draftValues) {
  const now = new Date().toISOString();
  return changeSessions([], sessions => {
    const index = findSession(sessions, sessionId);
    sessions[index] = approveSummary(sessions[index], draftValues, { now });
    return { sessions, value: sessions[index] };
  });
}

// ---- B: the learner's own AI by copy and paste (PRD 4 consent; the app itself sends nothing) ----

function consentsOf(values) {
  return values.study?.aiConsents ?? [];
}

function evidenceSources(session) {
  return [...new Set(session.evidence.map(ref => ref.sourceId))];
}

export async function aiConsents() {
  const values = await transact(['study'], 'readonly', saved => saved);
  return consentsOf(values);
}

// What the learner would copy now: the request, or what a consent must cover first.
export async function aiRequest(sessionId, { provider, purpose }) {
  const values = await transact(['study'], 'readonly', saved => saved);
  const session = sessionsOf(values).find(item => item.id === sessionId);
  if (!session) throw new Error('학습 기록을 찾을 수 없습니다. 새로고침해 주세요.');
  const sourceIds = evidenceSources(session);
  const consent = activeConsent(consentsOf(values), { provider, sourceIds, purpose });
  if (!consent) {
    return { consent: null, sourceIds, sourceTitles: [...new Set(session.evidence.map(ref => ref.sourceTitle))] };
  }
  return { consent, request: buildRequest(session, { purpose, includeSource: consent.sourceRights === 'confirmed' }) };
}

export async function grantAiConsent({ sessionId, provider, purpose, sourceRights }) {
  const now = new Date().toISOString();
  return changeSessions([], (sessions, values) => {
    const session = sessions[findSession(sessions, sessionId)];
    const consent = newConsent({ id: crypto.randomUUID(), provider, sourceIds: evidenceSources(session),
      allowedOperations: [purpose], sourceRights, now });
    return { sessions, extra: { aiConsents: [...consentsOf(values), consent] }, value: consent };
  });
}

export async function revokeAiConsent(consentId) {
  const now = new Date().toISOString();
  return changeSessions([], (sessions, values) => {
    const consents = consentsOf(values).map(consent => (consent.consentId === consentId && !consent.revokedAt
      ? { ...consent, revokedAt: now } : consent));
    return { sessions, extra: { aiConsents: consents }, value: null };
  });
}

// The pasted answer: stored on the session as an AI estimate, its learning-log candidates added as pending logs.
export async function saveAiReview(sessionId, { provider, purpose, response }) {
  const now = new Date().toISOString();
  return changeSessions([], (sessions, values, logs) => {
    const index = findSession(sessions, sessionId);
    const session = sessions[index];
    const consent = activeConsent(consentsOf(values), { provider, sourceIds: evidenceSources(session), purpose });
    if (!consent) throw new Error('이 서비스와 목적에 대한 동의가 없습니다. 먼저 동의해 주세요.');
    if ((session.aiReviews ?? []).length >= MAX_AI_REVIEWS) throw new Error(`AI 검토는 기록마다 ${MAX_AI_REVIEWS}개까지 저장합니다.`);
    const review = newAiReview({ id: crypto.randomUUID(), session, provider, purpose,
      includedSource: consent.sourceRights === 'confirmed', consentId: consent.consentId, response, now });
    const candidates = purpose === 'review' ? parseCandidates(review.response) : [];
    if (logs.length + candidates.length > MAX_LOGS) throw new Error(`학습로그는 ${MAX_LOGS}개까지 저장합니다.`);
    const added = candidates.map(candidate => candidateLog(candidate, { id: crypto.randomUUID(), now, session, reviewId: review.id }));
    sessions[index] = { ...session, aiReviews: [...(session.aiReviews ?? []), review], updatedAt: now };
    return { sessions, logs: [...logs, ...added],
      value: { review, candidates: added.length, cause: purpose === 'cause' ? parseCauseSuggestion(review.response) : null } };
  });
}

export async function decideStudyLog(id, action) {
  const now = new Date().toISOString();
  return changeSessions([], (sessions, _values, logs) => {
    const index = logs.findIndex(log => log.id === id);
    if (index < 0) throw new Error('학습로그를 찾을 수 없습니다. 새로고침해 주세요.');
    logs[index] = decideLog(logs[index], action, { now });
    return { sessions, logs, value: logs[index] };
  });
}

// ---- A-5 개인 Wiki로 내보내기 ----

// What an export would write now, its format check, and how each record compares with the last export.
export async function wikiExportPreview() {
  const values = await transact(['study', 'meta'], 'readonly', saved => saved);
  const now = new Date().toISOString();
  const { files, entries } = await buildWikiExport({ sessions: sessionsOf(values), logs: logsOf(values), now });
  const last = values.meta?.wikiExport ?? null;
  const counts = { new: 0, changed: 0, same: 0 };
  for (const entry of entries) {
    const previous = last?.revisions?.[entry.recordId];
    counts[!previous ? 'new' : previous === entry.revisionSha256 ? 'same' : 'changed'] += 1;
  }
  return { files, entries, problems: checkWikiExport(files), counts, lastExport: last };
}

export async function markWikiExported(entries, method) {
  const at = new Date().toISOString();
  await transact(['meta'], 'readwrite', (values, put) => {
    put('meta', { ...(values.meta ?? {}), wikiExport: { at, method,
      revisions: Object.fromEntries(entries.map(entry => [entry.recordId, entry.revisionSha256])) } });
  });
  notify();
}

export async function storageInfo() {
  const values = await transact(['events', 'setup', 'meta', 'study'], 'readonly', saved => saved);
  let persisted = null;
  try { persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null; } catch { persisted = null; }
  return {
    hasRecords: Boolean(values.setup) || (values.events?.length ?? 0) > 0 || (values.study?.sessions?.length ?? 0) > 0,
    lastBackupAt: values.meta?.lastBackupAt ?? null,
    persisted,
  };
}
