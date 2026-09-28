import { createServer as createHttpServer } from 'node:http';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readStore, appendToStore } from './store.mjs';
import { convertPdf } from './pdf.mjs';
import { calendarFor, clone, eventBuilder, isCalendarPath, isPdfBytes, localDate, parseSetupFields,
  planInputFromSetup, safeOriginalName, statusFor, studentError, studentPdfError, textlessPages, writePaths,
  writeResponse } from './app-core.mjs';

export { studentPdfError };

const defaultInputPath = resolve(import.meta.dirname, '../fixtures/synthetic-plan.json');
const defaultWebRoot = resolve(import.meta.dirname, '../web');
const jsonLimitBytes = 64 * 1024;
const setupLimitBytes = 32 * 1024 * 1024;
const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
]);

function readJsonFile(path) {
  if (statSync(path).size > 5 * 1024 * 1024) throw new Error('Input file exceeds 5 MiB');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readSetupFile(path) {
  if (!existsSync(path)) return null;
  if (statSync(path).size > 512 * 1024) throw new Error('Setup file exceeds 512 KiB');
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  if (saved.schemaVersion !== 1 || !saved.source || !Array.isArray(saved.tasks)) {
    throw new Error('Setup file schema is not supported');
  }
  return saved;
}

function isJsonContentType(value) {
  return typeof value === 'string' && /^application\/json(?:\s*;|$)/i.test(value);
}

async function readBody(request, requireJson) {
  if (requireJson && !isJsonContentType(request.headers['content-type'])) {
    throw new Error('JSON 요청만 처리합니다.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > jsonLimitBytes) throw new Error('JSON body exceeds 64 KiB');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error('JSON 형식이 올바르지 않습니다.', { cause: error });
  }
}

async function readRawBody(request, limitBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > limitBytes) throw new Error(`요청 본문이 ${Math.floor(limitBytes / 1024 / 1024)} MiB를 넘었습니다.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function multipartBoundary(contentType) {
  const match = /^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  return match?.[1] ?? match?.[2] ?? null;
}

function parseContentDisposition(value) {
  const result = {};
  for (const part of value.split(';').map(item => item.trim())) {
    const [key, rawValue] = part.split('=');
    if (!rawValue) continue;
    result[key.toLowerCase()] = rawValue.replace(/^"|"$/g, '');
  }
  return result;
}

function parseMultipartForm(buffer, boundary) {
  const marker = Buffer.from(`--${boundary}`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const parts = new Map();
  let cursor = buffer.indexOf(marker);
  if (cursor < 0) throw new Error('multipart boundary를 찾지 못했습니다.');
  cursor += marker.length;
  while (cursor < buffer.length) {
    if (buffer.subarray(cursor, cursor + 2).toString() === '--') break;
    if (buffer.subarray(cursor, cursor + 2).toString() === '\r\n') cursor += 2;
    const headerEnd = buffer.indexOf('\r\n\r\n', cursor, 'utf8');
    if (headerEnd < 0) throw new Error('multipart header가 올바르지 않습니다.');
    const headerText = buffer.subarray(cursor, headerEnd).toString('utf8');
    const headers = new Map(headerText.split('\r\n').map(line => {
      const index = line.indexOf(':');
      return [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
    }));
    const disposition = parseContentDisposition(headers.get('content-disposition') ?? '');
    const dataStart = headerEnd + 4;
    const next = buffer.indexOf(delimiter, dataStart);
    if (next < 0) throw new Error('multipart 종료 boundary를 찾지 못했습니다.');
    parts.set(disposition.name, {
      filename: disposition.filename,
      contentType: headers.get('content-type') ?? 'application/octet-stream',
      data: buffer.subarray(dataStart, next),
    });
    cursor = next + 2 + marker.length;
  }
  return parts;
}

function partText(parts, name) {
  return parts.get(name)?.data.toString('utf8').trim() ?? '';
}

function buildSetup({ parts, sourceDir, draftDir, pdfConverter = convertPdf }) {
  const file = parts.get('pdf');
  if (!file || !file.filename || file.data.length === 0) throw new Error('PDF 파일을 선택해 주세요.');
  const originalName = safeOriginalName(file.filename);
  if (!originalName.toLowerCase().endsWith('.pdf') || !isPdfBytes(file.data)) {
    throw new Error('PDF 파일만 등록할 수 있습니다.');
  }
  const { title, dailyMinutes, weeklyMinutes, tasks, selectedPages } =
    parseSetupFields(name => partText(parts, name));
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(draftDir, { recursive: true });
  const storedFile = join(sourceDir, `${randomUUID()}.pdf`);
  let extraction;
  let sourceId;
  try {
    writeFileSync(storedFile, file.data, { flag: 'wx' });
    sourceId = `local-pdf-${randomUUID()}`;
    extraction = pdfConverter({
      pdfPath: storedFile,
      sourceId,
      title,
      edition: originalName,
      selectedPages,
    });
  } catch (error) {
    cleanupFile(storedFile);
    throw new Error(studentPdfError(error.message), { cause: error });
  }
  const manifestFile = join(draftDir, `${sourceId}.manifest.json`);
  const draftFile = join(draftDir, `${sourceId}.draft.md`);
  try {
    writeFileSync(manifestFile, JSON.stringify(extraction.manifest, null, 2) + '\n', { flag: 'wx' });
    writeFileSync(draftFile, extraction.draftMarkdown, { flag: 'wx' });
  } catch (error) {
    cleanupFile(storedFile);
    cleanupFile(manifestFile);
    cleanupFile(draftFile);
    throw error;
  }
  const setup = {
    schemaVersion: 1,
    id: `setup-${randomUUID()}`,
    title,
    dailyMinutes,
    weeklyMinutes,
    tasks,
    source: {
      originalName,
      storedFile,
      sizeBytes: file.data.length,
      uploadedAt: new Date().toISOString(),
      selectedPages,
      extractionStatus: extraction.summary.failedPages.length > 0 ? 'failed' : 'needs_review',
      extraction: {
        manifestFile,
        draftFile,
        summary: extraction.summary,
        // Pages that yielded no text (scans or blank pages); the screen must not call them drafts.
        textlessPages: textlessPages(extraction, selectedPages),
      },
    },
  };
  return setup;
}

function archivePathFor(storeFile, archiveDir) {
  if (!existsSync(storeFile)) return null;
  mkdirSync(archiveDir, { recursive: true });
  return join(archiveDir, `study-web-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
}

function setupArchivePathFor(configFile, archiveDir) {
  if (!existsSync(configFile)) return null;
  mkdirSync(archiveDir, { recursive: true });
  return join(archiveDir, `setup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
}

function writeSetupTemp(configFile, setup) {
  mkdirSync(dirname(configFile), { recursive: true });
  const temporary = `${configFile}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(setup, null, 2) + '\n', { flag: 'wx' });
    return temporary;
  } catch (error) {
    cleanupFile(temporary);
    throw error;
  }
}

function cleanupFile(path) {
  if (!path || !existsSync(path)) return;
  if (lstatSync(path).isDirectory()) return;
  unlinkSync(path);
}

function cleanupSetupArtifacts(setup) {
  cleanupFile(setup?.source?.storedFile);
  cleanupFile(setup?.source?.extraction?.manifestFile);
  cleanupFile(setup?.source?.extraction?.draftFile);
}

function setupArtifacts(setup) {
  return {
    storedFile: setup?.source?.storedFile ?? null,
    manifestFile: setup?.source?.extraction?.manifestFile ?? null,
    draftFile: setup?.source?.extraction?.draftFile ?? null,
  };
}

function cleanupArtifacts(artifacts) {
  cleanupFile(artifacts?.storedFile);
  cleanupFile(artifacts?.manifestFile);
  cleanupFile(artifacts?.draftFile);
}

function writeJournal(journalFile, journal) {
  mkdirSync(dirname(journalFile), { recursive: true });
  const temporary = `${journalFile}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(journal, null, 2) + '\n', { flag: 'wx' });
    renameSync(temporary, journalFile);
  } catch (error) {
    cleanupFile(temporary);
    throw error;
  }
}

function readJsonIfExists(file) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function currentSetupId(configFile) {
  try {
    return readSetupFile(configFile)?.id ?? null;
  } catch {
    return null;
  }
}

function canonicalPath(path) {
  const full = resolve(path);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

function samePath(left, right) {
  return canonicalPath(left) === canonicalPath(right);
}

function safeDirectoryRoot(directory) {
  if (!existsSync(directory)) return true;
  return !lstatSync(directory).isSymbolicLink();
}

function directChildOf(path, directory) {
  return safeDirectoryRoot(directory) && samePath(dirname(path), directory);
}

function safeOptionalPath(value, predicate) {
  return value === null || value === undefined || (typeof value === 'string' && predicate(value));
}

const uuidPathPartPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uuidPattern = new RegExp(`^${uuidPathPartPattern}$`, 'i');
const uuidJsonSuffixPattern = new RegExp(`${uuidPathPartPattern}\\.json$`, 'i');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeArchiveJsonPath(file, archiveDir, prefix) {
  return directChildOf(file, archiveDir) && basename(file).startsWith(prefix) && uuidJsonSuffixPattern.test(basename(file));
}

function safeSetupTempPath(file, configFile) {
  const name = basename(file);
  const pattern = new RegExp(`^${escapeRegExp(basename(configFile))}\\.${uuidPathPartPattern}\\.tmp$`, 'i');
  return samePath(dirname(file), dirname(configFile)) &&
    pattern.test(name);
}

function safeSourcePdfPath(file, sourceDir) {
  return directChildOf(file, sourceDir) && new RegExp(`^${uuidPathPartPattern}\\.pdf$`, 'i').test(basename(file));
}

function safeDraftArtifactPath(file, draftDir, suffix) {
  return directChildOf(file, draftDir) &&
    new RegExp(`^local-pdf-${uuidPathPartPattern}${escapeRegExp(suffix)}$`, 'i').test(basename(file));
}

function setupArtifactPaths(setup) {
  return [
    setup?.source?.storedFile,
    setup?.source?.extraction?.manifestFile,
    setup?.source?.extraction?.draftFile,
  ].filter(item => typeof item === 'string');
}

function readSetupIfPresent(file) {
  if (!file || !existsSync(file)) return { ok: true, setup: null };
  try {
    return { ok: true, setup: readSetupFile(file) };
  } catch {
    return { ok: false, setup: null };
  }
}

function artifactPathsEqual(left, right) {
  return ['storedFile', 'manifestFile', 'draftFile'].every(key =>
    typeof left?.[key] === 'string' && typeof right?.[key] === 'string' && samePath(left[key], right[key]));
}

function artifactPathsOverlap(left, right) {
  const leftPaths = setupArtifactPaths(left).map(canonicalPath);
  const rightPaths = Object.values(right ?? {}).filter(item => typeof item === 'string').map(canonicalPath);
  return leftPaths.some(item => rightPaths.includes(item));
}

function cleanupAllowedBySetupTemp(journal) {
  const current = readSetupIfPresent(journal.configFile);
  const archived = readSetupIfPresent(journal.previousSetupArchiveFile);
  if (!current.ok || !archived.ok) return false;
  const temp = readSetupIfPresent(journal.setupTemp);
  if (!temp.ok || !temp.setup) return false;
  if (temp.setup.id !== journal.newSetupId) return false;
  if (!artifactPathsEqual(setupArtifacts(temp.setup), journal.newArtifacts)) return false;
  return !artifactPathsOverlap(current.setup, journal.newArtifacts) &&
    !artifactPathsOverlap(archived.setup, journal.newArtifacts);
}

function validateTransitionJournal(journal, { configFile, storeFile, sourceDir, draftDir, archiveDir, journalFile }) {
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) return null;
  if (journal.schemaVersion !== 1) return null;
  if (typeof journal.newSetupId !== 'string' || !journal.newSetupId.startsWith('setup-') ||
      !uuidPattern.test(journal.newSetupId.slice('setup-'.length))) return null;
  if (typeof journal.configFile !== 'string' || typeof journal.storeFile !== 'string') return null;
  if (journal.journalFile !== undefined && typeof journal.journalFile !== 'string') return null;
  if (!samePath(journal.configFile, configFile)) return null;
  if (!samePath(journal.storeFile, storeFile)) return null;
  if (journal.journalFile !== undefined && !samePath(journal.journalFile, journalFile)) return null;
  if (typeof journal.setupTemp !== 'string' || !safeSetupTempPath(journal.setupTemp, configFile)) return null;
  if (!safeOptionalPath(journal.storeArchiveFile, file => safeArchiveJsonPath(file, archiveDir, 'study-web-'))) return null;
  if (!safeOptionalPath(journal.previousSetupArchiveFile, file => safeArchiveJsonPath(file, archiveDir, 'setup-'))) return null;
  const artifacts = journal.newArtifacts;
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) return null;
  if (!safeOptionalPath(artifacts.storedFile, file => safeSourcePdfPath(file, sourceDir))) return null;
  if (!safeOptionalPath(artifacts.manifestFile, file => safeDraftArtifactPath(file, draftDir, '.manifest.json'))) return null;
  if (!safeOptionalPath(artifacts.draftFile, file => safeDraftArtifactPath(file, draftDir, '.draft.md'))) return null;
  return journal;
}

function transitionComplete(journal, configFile) {
  return currentSetupId(configFile) === journal.newSetupId;
}

function restoreFromJournal(journal) {
  const cleanupNewArtifacts = cleanupAllowedBySetupTemp(journal);
  cleanupFile(journal.setupTemp);
  if (journal.previousSetupArchiveFile && existsSync(journal.previousSetupArchiveFile)) {
    if (existsSync(journal.configFile)) cleanupFile(journal.configFile);
    renameSync(journal.previousSetupArchiveFile, journal.configFile);
  }
  if (!existsSync(journal.storeFile) && journal.storeArchiveFile && existsSync(journal.storeArchiveFile)) {
    renameSync(journal.storeArchiveFile, journal.storeFile);
  }
  if (cleanupNewArtifacts) cleanupArtifacts(journal.newArtifacts);
}

function recoverSetupTransition({ journalFile, configFile, storeFile, sourceDir, draftDir, archiveDir }) {
  const journal = validateTransitionJournal(readJsonIfExists(journalFile), {
    configFile,
    storeFile,
    sourceDir,
    draftDir,
    archiveDir,
    journalFile,
  });
  if (!journal) return;
  if (transitionComplete(journal, configFile)) {
    cleanupFile(journal.setupTemp);
    cleanupFile(journalFile);
    return;
  }
  restoreFromJournal(journal);
  cleanupFile(journalFile);
}

function installSetup({ setup, configFile, storeFile, archiveDir, journalFile }) {
  const storeArchiveFile = archivePathFor(storeFile, archiveDir);
  const previousSetupArchiveFile = setupArchivePathFor(configFile, archiveDir);
  setup.archiveFile = storeArchiveFile;
  setup.previousSetupArchiveFile = previousSetupArchiveFile;
  let journal = null;
  let journalPersisted = false;
  try {
    const setupTemp = writeSetupTemp(configFile, setup);
    journal = {
      schemaVersion: 1,
      journalFile,
      newSetupId: setup.id,
      configFile,
      setupTemp,
      storeFile,
      storeArchiveFile,
      previousSetupArchiveFile,
      newArtifacts: setupArtifacts(setup),
    };
    writeJournal(journalFile, journal);
    journalPersisted = true;
    if (previousSetupArchiveFile) renameSync(configFile, previousSetupArchiveFile);
    if (storeArchiveFile) renameSync(storeFile, storeArchiveFile);
    renameSync(setupTemp, configFile);
    cleanupFile(journalFile);
    return setup;
  } catch (error) {
    if (journalPersisted) {
      restoreFromJournal(journal);
    } else {
      cleanupFile(journal?.setupTemp);
      cleanupSetupArtifacts(setup);
    }
    cleanupFile(journalFile);
    throw error;
  }
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value, null, 2));
}

function sendStatic(response, webRoot, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const relative = normalize(decodeURIComponent(requested)).replace(/^([/\\])+/, '');
  const full = resolve(join(webRoot, relative));
  if (full !== webRoot && !full.startsWith(`${webRoot}${sep}`)) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }
  try {
    const data = readFileSync(full);
    response.writeHead(200, {
      'content-type': mimeTypes.get(extname(full)) ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(data);
  } catch {
    sendJson(response, 404, { error: 'Not found' });
  }
}

function hostNameFromHeader(value) {
  if (!value) return null;
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  return value.split(':')[0];
}

function requestOriginAllowed(request) {
  const host = request.headers.host;
  const hostName = hostNameFromHeader(host);
  if (!localHosts.has(hostName)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (!localHosts.has(parsed.hostname)) return false;
    return parsed.host === host;
  } catch {
    return false;
  }
}

export function createServer({
  storeFile = resolve(process.env.CHALLENGE_MASTER_DATA_DIR ?? resolve(process.cwd(), 'private'), 'study-web.json'),
  planInput,
  webRoot = defaultWebRoot,
  planSource = 'synthetic_demo',
  configFile = resolve(dirname(storeFile), 'setup.json'),
  sourceDir = resolve(dirname(storeFile), 'sources'),
  draftDir = resolve(dirname(storeFile), 'drafts'),
  archiveDir = resolve(dirname(storeFile), 'archives'),
  journalFile = resolve(dirname(storeFile), 'setup-transition.json'),
  pdfConverter = convertPdf,
} = {}) {
  recoverSetupTransition({ journalFile, configFile, storeFile, sourceDir, draftDir, archiveDir });
  const fixedInput = planInput ? clone(planInput) : null;
  if (fixedInput && Object.hasOwn(fixedInput, 'completedTaskIds')) {
    throw new Error('저장 계획에는 completedTaskIds를 넣을 수 없습니다. 완료 기록은 별도 이벤트로 남기세요.');
  }

  function runtimePlan() {
    const storage = 'local';
    if (fixedInput) return { input: clone(fixedInput), source: planSource, setup: null, storage };
    const setup = readSetupFile(configFile);
    if (setup) return { input: planInputFromSetup(setup), source: `local_setup:${setup.source.originalName}`, setup, storage };
    return { input: readJsonFile(defaultInputPath), source: 'synthetic_demo', setup: null, storage };
  }

  const apiStatus = statusFor;

  let httpServer;

  async function handleApi(request, response, url) {
    if (!requestOriginAllowed(request)) {
      sendJson(response, 403, { error: '로컬호스트에서 보낸 요청만 처리합니다.' });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/setup') {
      if (fixedInput) throw new Error('고정 입력 모드에서는 PDF 설정을 등록할 수 없습니다. CHALLENGE_MASTER_INPUT을 해제한 뒤 사용해 주세요.');
      const boundary = multipartBoundary(request.headers['content-type']);
      if (!boundary) throw new Error('PDF 등록은 multipart/form-data 요청만 처리합니다.');
      const parts = parseMultipartForm(await readRawBody(request, setupLimitBytes), boundary);
      const setup = buildSetup({ parts, sourceDir, draftDir, pdfConverter });
      installSetup({ setup, configFile, storeFile, archiveDir, journalFile });
      const runtime = runtimePlan();
      sendJson(response, 200, apiStatus(readStore(storeFile), { ...runtime, setup }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/quit') {
      sendJson(response, 200, { ok: true, message: '앱을 종료합니다.' });
      setImmediate(() => httpServer.close());
      return;
    }
    const body = ['POST', 'PUT', 'PATCH'].includes(request.method) ? await readBody(request, true) : {};
    const runtime = runtimePlan();
    const baseInput = runtime.input;
    if (request.method === 'GET' && url.pathname === '/api/status') {
      sendJson(response, 200, apiStatus(readStore(storeFile), runtime));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/calendar') {
      const month = url.searchParams.get('month') ?? localDate().slice(0, 7);
      sendJson(response, 200, calendarFor(readStore(storeFile), month, runtime));
      return;
    }
    if (request.method === 'POST' && writePaths.has(url.pathname)) {
      try {
        const state = appendToStore(storeFile, eventBuilder(url.pathname, body, runtime));
        sendJson(response, 200, writeResponse(url.pathname, body, state, runtime));
      } catch (error) {
        throw isCalendarPath(url.pathname) ? studentError(error) : error;
      }
      return;
    }
    sendJson(response, 404, { error: '지원하지 않는 API 경로입니다.' });
  }

  httpServer = createHttpServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      handleApi(request, response, url).catch(error => sendJson(response, 400, { error: error.message }));
      return;
    }
    sendStatic(response, resolve(webRoot), url.pathname);
  });
  return httpServer;
}

export function startServer(options = {}) {
  const { port = 3000, host = '127.0.0.1', ...serverOptions } = options;
  if (!localHosts.has(host)) throw new Error('로컬호스트에만 바인드할 수 있습니다.');
  const server = createServer(serverOptions);
  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(port, host, () => {
      server.off('error', rejectStart);
      resolveStart({ server, url: `http://${host}:${server.address().port}` });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number.parseInt(process.env.CHALLENGE_MASTER_PORT ?? '3000', 10);
  const storeFile = process.env.CHALLENGE_MASTER_STORE ??
    resolve(process.env.CHALLENGE_MASTER_DATA_DIR ?? resolve(process.cwd(), 'private'), 'study-web.json');
  const inputFile = process.env.CHALLENGE_MASTER_INPUT;
  const options = inputFile
    ? { port, storeFile, planInput: readJsonFile(resolve(inputFile)), planSource: `local_file:${resolve(inputFile)}` }
    : { port, storeFile };
  startServer(options).then(({ url }) => {
    console.log(`Challenge Master local web UI: ${url}`);
    console.log(`Store: ${storeFile}`);
    console.log(`Input: ${inputFile ? `local_file:${resolve(inputFile)}` : 'saved_setup_or_synthetic_demo'}`);
  }).catch(error => {
    console.error(`오류: ${error.message}`);
    process.exitCode = 1;
  });
}
