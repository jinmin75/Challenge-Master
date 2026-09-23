import { createServer as createHttpServer } from 'node:http';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { planDay } from './scheduler.mjs';
import { planFromProgress } from './replan.mjs';
import { planWeek } from './weekly.mjs';
import { readStore, appendToStore } from './store.mjs';
import { convertPdf } from './pdf.mjs';

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

function clone(value) {
  return structuredClone(value);
}

function localDateIso(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addLocalDays(date, days) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() + days);
  return copy;
}

function weekDaysFromSetup(setup, startDate = new Date()) {
  let remaining = setup.weeklyMinutes;
  return Array.from({ length: 7 }, (_, index) => {
    const availableMinutes = Math.min(setup.dailyMinutes, remaining);
    remaining = Math.max(0, remaining - availableMinutes);
    return {
      date: localDateIso(addLocalDays(startDate, index)),
      availableMinutes,
      rest: availableMinutes === 0,
    };
  });
}

function planInputFromSetup(setup) {
  const setupId = setup.id ?? 'setup-legacy';
  const tasks = setup.tasks.map((task, index) => ({
    id: `${setupId}-task-${index + 1}`,
    title: task.title,
    kind: task.kind,
    minutes: task.minutes,
    splittable: true,
  }));
  return {
    date: localDateIso(),
    availableMinutes: setup.dailyMinutes,
    remainingStudyMinutes: tasks.reduce((sum, task) => sum + task.minutes, 0),
    tasks,
    weekDays: weekDaysFromSetup(setup),
  };
}

function pageStatusList(setup) {
  const summary = setup.source.extraction?.summary;
  if (!summary) return [];
  return summary.selectedPages.map(number => ({
    pdfPageIndex: number,
    status: summary.failedPages.includes(number) ? 'failed' : 'needs_review',
    reviewRequired: true,
  }));
}

function publicSetup(setup) {
  if (!setup) return {
    configured: false,
    message: '합성 데모입니다. PDF와 공부 범위를 등록하면 그 설정으로 계획을 만듭니다.',
  };
  return {
    configured: true,
    title: setup.title,
    dailyMinutes: setup.dailyMinutes,
    weeklyMinutes: setup.weeklyMinutes,
    tasks: setup.tasks,
    archiveFile: setup.archiveFile ?? null,
    source: {
      originalName: setup.source.originalName,
      sizeBytes: setup.source.sizeBytes,
      extractionStatus: setup.source.extractionStatus,
      selectedPages: setup.source.selectedPages ?? [],
      pages: pageStatusList(setup),
      draftFile: setup.source.extraction?.draftFile ?? null,
      manifestFile: setup.source.extraction?.manifestFile ?? null,
    },
    message: setup.archiveFile
      ? '이전 계획 기록은 별도 파일로 보존했고, 새 자료는 빈 계획 기록에서 시작합니다. 추출 초안은 원본 대조 필요 상태입니다.'
      : 'PDF 원본과 추출 초안은 이 PC에 저장했습니다. 각 페이지는 원본 대조 필요 상태이며, 검토 전에는 ready나 공부 완료로 반영하지 않습니다.',
  };
}

function parseMinutes(value, field, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value)) throw new Error(`${field} 값은 정수여야 합니다.`);
  if (allowZero ? value < 0 : value <= 0) throw new Error(`${field} 값이 허용 범위를 벗어났습니다.`);
  return value;
}

function planInputFor(requestBody, baseInput) {
  const input = clone(baseInput);
  input.date = localDateIso();
  if (requestBody && Object.hasOwn(requestBody, 'date')) input.date = requestBody.date;
  if (requestBody && Object.hasOwn(requestBody, 'availableMinutes')) {
    input.availableMinutes = parseMinutes(requestBody.availableMinutes, 'availableMinutes', { allowZero: true });
  }
  if (requestBody && Object.hasOwn(requestBody, 'rest')) input.rest = requestBody.rest === true;
  return input;
}

function currentPlanProgress(state, taskId) {
  return state.progress
    .filter(item => item.planVersion === state.currentPlan?.planVersion && item.taskId === taskId)
    .reduce((sum, item) => sum + item.completedMinutes, 0);
}

function currentPlanSkipped(state) {
  return new Set(state.noncompletion
    .filter(item => item.planVersion === state.currentPlan?.planVersion && item.confirmed === true)
    .map(item => item.taskId));
}

function displayPlan(state) {
  const plan = state.currentPlan;
  if (!plan) return null;
  const skipped = currentPlanSkipped(state);
  const allocations = plan.allocations
    .map(item => ({ ...item, minutes: item.minutes - currentPlanProgress(state, item.taskId) }))
    .filter(item => item.minutes > 0 && !skipped.has(item.taskId));
  const assignedMinutes = allocations.reduce((sum, item) => sum + item.minutes, 0);
  return { ...plan, allocations, assignedMinutes };
}

function deriveRecommendedAction(state, plan = displayPlan(state)) {
  if (!plan) return { kind: 'start', label: '오늘 계획 시작', taskId: null, minutes: null };
  const allocation = plan.allocations[0] ?? null;
  if (!allocation) {
    const reason = plan.deferred[0]?.reason ?? 'no_allocation';
    return { kind: 'wait', label: reason === 'rest_day' ? '오늘은 휴식입니다' : '다음 계획 조정이 필요합니다', taskId: null, minutes: 0 };
  }
  return {
    kind: 'study',
    label: `${allocation.title} ${allocation.minutes}분을 시작해 주세요`,
    taskId: allocation.taskId,
    minutes: allocation.minutes,
  };
}

function weeklyDaysFor(baseInput, state) {
  const today = localDateIso();
  const current = state.currentPlan;
  const applyCurrentPlan = day => current?.date === day.date ? {
    ...day,
    availableMinutes: current.availableMinutes,
    rest: current.allocatableMinutes === 0 && current.deferred.some(item => item.reason === 'rest_day'),
  } : day;
  if (Array.isArray(baseInput.weekDays) && baseInput.weekDays.length > 0) {
    return baseInput.weekDays.filter(day => day.date >= today).map(day => applyCurrentPlan({
      date: day.date,
      availableMinutes: day.availableMinutes ?? baseInput.availableMinutes,
      rest: day.rest ?? false,
    }));
  }
  const start = current?.date && current.date > today
    ? new Date(`${current.date}T00:00:00`)
    : new Date();
  return Array.from({ length: 7 }, (_, index) => applyCurrentPlan({
    date: localDateIso(addLocalDays(start, index)),
    availableMinutes: baseInput.availableMinutes,
  }));
}

function weeklyForecastFor(baseInput, state) {
  return planWeek({
    days: weeklyDaysFor(baseInput, state),
    tasks: clone(baseInput.tasks),
    nextTwoDaysReviewMinutes: baseInput.nextTwoDaysReviewMinutes ?? null,
    planVersion: (state.currentPlan?.planVersion ?? 0) + 1,
  }, state);
}

function summarizeState(state, baseInput) {
  const confirmedMinutes = state.progress.reduce((sum, item) => sum + item.completedMinutes, 0);
  const currentPlan = displayPlan(state);
  let weeklyForecast = null;
  let weeklyForecastError = null;
  try {
    weeklyForecast = weeklyForecastFor(baseInput, state);
  } catch (error) {
    weeklyForecastError = `주간 예측을 갱신하지 못했습니다: ${error.message}`;
  }
  return {
    currentPlan,
    rawCurrentPlan: state.currentPlan,
    eventCount: state.events.length,
    confirmedProgressMinutes: confirmedMinutes,
    attempts: state.attempts.map(item => ({
      taskId: item.taskId,
      evidenceType: item.evidenceType,
      assistanceExposure: item.assistanceExposure,
      planVersion: item.planVersion,
    })),
    progress: state.progress.map(item => ({
      taskId: item.taskId,
      completedMinutes: item.completedMinutes,
      planVersion: item.planVersion,
      learnerConfirmed: item.learnerConfirmed,
    })),
    noncompletion: state.noncompletion.map(item => ({
      taskId: item.taskId,
      planVersion: item.planVersion,
      confirmed: item.confirmed,
    })),
    recommendedAction: deriveRecommendedAction(state, currentPlan),
    planSource: '합성 데모 입력입니다. 실제 과업은 로컬 파일을 CHALLENGE_MASTER_INPUT으로 지정해 주세요.',
    progressContract: '학생이 직접 확인한 실제 공부 시간만 다음 계획에서 차감합니다. 자기보고와 스킵은 숙달이나 완료로 바꾸지 않습니다.',
    weeklyForecast,
    weeklyForecastError,
  };
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

function parsePositiveInt(value, field) {
  if (!/^[1-9]\d*$/.test(String(value).trim())) throw new Error(`${field} 값은 1 이상의 정수여야 합니다.`);
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} 값은 1 이상의 정수여야 합니다.`);
  return parsed;
}

function parseSetupTasks(value) {
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error('공부 범위를 한 줄 이상 입력해 주세요.');
  if (lines.length > 30) throw new Error('공부 범위는 30개 이하로 입력해 주세요.');
  return lines.map((line, index) => {
    const [titleRaw, minutesRaw, kindRaw] = line.split('|').map(part => part.trim());
    if (!titleRaw) throw new Error(`${index + 1}번째 공부 범위 제목을 입력해 주세요.`);
    if (titleRaw.length > 120) throw new Error(`${index + 1}번째 공부 범위 제목이 너무 깁니다.`);
    const minutes = minutesRaw ? parsePositiveInt(minutesRaw, `${index + 1}번째 공부 범위 시간`) : 30;
    const kind = taskKindFromText(kindRaw);
    return { title: titleRaw, minutes, kind };
  });
}

function taskKindFromText(value = '') {
  const normalized = value.trim().toLowerCase();
  if (['review', '복습', '확인', '확인·교정'].includes(normalized)) return 'review';
  if (['new', '새 내용', '새내용', '새 범위', '새범위', ''].includes(normalized)) return 'new';
  throw new Error('공부 범위 종류는 새 내용 또는 복습으로 입력해 주세요.');
}

function selectedPagesFromParts(parts) {
  const start = parsePositiveInt(partText(parts, 'pageStart') || '1', '시작 페이지');
  const end = parsePositiveInt(partText(parts, 'pageEnd') || String(start), '끝 페이지');
  if (end < start) throw new Error('끝 페이지는 시작 페이지보다 작을 수 없습니다.');
  if (end - start + 1 > 30) throw new Error('한 번에 추출할 수 있는 페이지는 30쪽 이하입니다.');
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function safeOriginalName(filename) {
  const name = basename(filename || 'source.pdf').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;
}

function buildSetup({ parts, sourceDir, draftDir, pdfConverter = convertPdf }) {
  const file = parts.get('pdf');
  if (!file || !file.filename || file.data.length === 0) throw new Error('PDF 파일을 선택해 주세요.');
  const originalName = safeOriginalName(file.filename);
  if (!originalName.toLowerCase().endsWith('.pdf') || file.data.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('PDF 파일만 등록할 수 있습니다.');
  }
  const title = partText(parts, 'title') || '내 학습 자료';
  if (title.length > 120) throw new Error('자료 제목이 너무 깁니다.');
  const dailyMinutes = parsePositiveInt(partText(parts, 'dailyMinutes'), '하루 공부 시간');
  const weeklyMinutes = parsePositiveInt(partText(parts, 'weeklyMinutes'), '이번 주 공부 시간');
  const tasks = parseSetupTasks(partText(parts, 'tasks'));
  const selectedPages = selectedPagesFromParts(parts);
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
    throw error;
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

function eventBase(type) {
  return { id: randomUUID(), type, at: new Date().toISOString() };
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
    if (fixedInput) return { input: clone(fixedInput), source: planSource, setup: null };
    const setup = readSetupFile(configFile);
    if (setup) return { input: planInputFromSetup(setup), source: `local_setup:${setup.source.originalName}`, setup };
    return { input: readJsonFile(defaultInputPath), source: 'synthetic_demo', setup: null };
  }

  function apiStatus(state, runtime) {
    return {
      ...summarizeState(state, runtime.input),
      planSource: runtime.source,
      setup: publicSetup(runtime.setup),
    };
  }

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
    if (request.method === 'POST' && url.pathname === '/api/start') {
      const state = appendToStore(storeFile, before => {
        const input = planInputFor(body, baseInput);
        const plan = before.currentPlan
          ? planFromProgress(input, before)
          : planDay({ ...input, planVersion: 1 });
        return { ...eventBase('plan_created'), plan };
      });
      sendJson(response, 200, apiStatus(state, runtime));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/progress') {
      const minutes = parseMinutes(body.completedMinutes, 'completedMinutes');
      if (body.requestId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) {
        throw new Error('requestId는 UUID v4 형식이어야 합니다.');
      }
      const state = appendToStore(storeFile, before => {
        const previous = body.requestId && before.events.find(item => item.id === body.requestId);
        if (previous) {
          if (previous.type !== 'task_progress_recorded' || previous.taskId !== body.taskId ||
              previous.completedMinutes !== minutes) throw new Error('requestId가 다른 기록에 사용됐습니다.');
          return previous;
        }
        if (!before.currentPlan) throw new Error('계획을 먼저 시작해 주세요.');
        return {
          ...eventBase('task_progress_recorded'), id: body.requestId ?? randomUUID(),
          taskId: body.taskId,
          planVersion: before.currentPlan.planVersion,
          completedMinutes: minutes,
          learnerConfirmed: true,
        };
      });
      sendJson(response, 200, apiStatus(state, runtime));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/attempt') {
      const state = appendToStore(storeFile, before => {
        if (!before.currentPlan) throw new Error('계획을 먼저 시작해 주세요.');
        return {
          ...eventBase('attempt_recorded'),
          taskId: body.taskId,
          planVersion: before.currentPlan.planVersion,
          evidenceType: body.evidenceType ?? 'observed_attempt',
          assistanceExposure: body.assistanceExposure ?? 'unknown',
          sourceVersion: body.sourceVersion ?? null,
          response: body.response ?? '',
        };
      });
      sendJson(response, 200, apiStatus(state, runtime));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/shorten') {
      const availableMinutes = parseMinutes(body.availableMinutes, 'availableMinutes', { allowZero: true });
      const state = appendToStore(storeFile, before => {
        if (!before.currentPlan) throw new Error('계획을 먼저 시작해 주세요.');
        return {
          ...eventBase('plan_created'),
          plan: planFromProgress(planInputFor({ ...body, availableMinutes }, baseInput), before),
        };
      });
      sendJson(response, 200, apiStatus(state, runtime));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/rest') {
      const state = appendToStore(storeFile, before => {
        return {
          ...eventBase('plan_created'),
          plan: before.currentPlan
            ? planFromProgress(planInputFor({ ...body, rest: true }, baseInput), before)
            : planDay({ ...planInputFor({ ...body, rest: true }, baseInput), planVersion: 1 }),
        };
      });
      sendJson(response, 200, apiStatus(state, runtime));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/skip') {
      const state = appendToStore(storeFile, before => {
        if (!before.currentPlan) throw new Error('계획을 먼저 시작해 주세요.');
        return {
          ...eventBase('noncompletion_confirmed'),
          taskId: body.taskId,
          planVersion: before.currentPlan.planVersion,
          confirmed: true,
        };
      });
      sendJson(response, 200, apiStatus(state, runtime));
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
