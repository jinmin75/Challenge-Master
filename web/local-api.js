// Web version (D022): the same request rules as the local app, with records kept only in this browser's
// IndexedDB. Nothing is sent anywhere; the PDF is read in the page and only the extracted text is kept.
// Loaded by app.js only when the page is built with data-mode="browser" (scripts/build-web.mjs).
import { applyEvent, emptyState } from './src/events.mjs';
import { calendarFor, eventBuilder, isPdfBytes, localDate, parseSetupFields, planInputFromSetup, safeOriginalName,
  statusFor, studentError, studentPdfError, textlessPages, writePaths, writeResponse } from './src/app-core.mjs';
import { MAX_PDF_BYTES, manifestFromExtraction } from './src/pdf-core.mjs';
import { readPdfPages } from './src/pdf-read.mjs';
import { sourcePages } from './src/study-core.mjs';

const DB_NAME = 'challenge-master';
const STORE = 'kv';
const BACKUP_KIND = 'challenge-master-backup';
const RECORD_KEYS = ['setup', 'events', 'draft', 'archives', 'meta'];
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
async function runtimeFor(setup) {
  if (setup) {
    return { input: planInputFromSetup(setup), source: `local_setup:${setup.source.originalName}`, setup, storage: 'browser' };
  }
  demoInput ??= await (await fetch(new URL('./fixtures/synthetic-plan.json', import.meta.url))).json();
  return { input: structuredClone(demoInput), source: 'synthetic_demo', setup: null, storage: 'browser' };
}

// Same paths and answers as the local app's /api routes, so app.js and calendar.js run unchanged.
export async function request(path, body) {
  const url = new URL(path, 'https://challenge-master.invalid');
  const saved = await transact(['setup', 'events'], 'readonly', values => values);
  const runtime = await runtimeFor(saved.setup);
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
  const backup = await transact(['setup', 'events', 'draft', 'archives', 'meta'], 'readwrite', (values, put) => {
    put('meta', { ...(values.meta ?? {}), lastBackupAt: exportedAt });
    return {
      kind: BACKUP_KIND, schemaVersion: 1, exportedAt,
      setup: values.setup ?? null, events: values.events ?? [], draft: values.draft ?? null,
      archives: values.archives ?? [],
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
  } catch (error) {
    throw new Error('백업 파일의 기록이 손상되어 불러올 수 없습니다.', { cause: error });
  }
  await transact([], 'readwrite', (_, put) => {
    put('setup', backup.setup ?? undefined);
    put('events', backup.events);
    put('draft', backup.draft ?? undefined);
    put('archives', backup.archives ?? []);
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

export async function storageInfo() {
  const values = await transact(['events', 'setup', 'meta'], 'readonly', saved => saved);
  let persisted = null;
  try { persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null; } catch { persisted = null; }
  return {
    hasRecords: Boolean(values.setup) || (values.events?.length ?? 0) > 0,
    lastBackupAt: values.meta?.lastBackupAt ?? null,
    persisted,
  };
}
