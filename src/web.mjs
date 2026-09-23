import { createServer as createHttpServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { planDay } from './scheduler.mjs';
import { planFromProgress } from './replan.mjs';
import { planWeek } from './weekly.mjs';
import { readStore, appendToStore } from './store.mjs';

const defaultInputPath = resolve(import.meta.dirname, '../fixtures/synthetic-plan.json');
const defaultWebRoot = resolve(import.meta.dirname, '../web');
const jsonLimitBytes = 64 * 1024;
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
  planInput = readJsonFile(defaultInputPath),
  webRoot = defaultWebRoot,
  planSource = 'synthetic_demo',
} = {}) {
  const baseInput = clone(planInput);
  if (Object.hasOwn(baseInput, 'completedTaskIds')) {
    throw new Error('저장 계획에는 completedTaskIds를 넣을 수 없습니다. 완료 기록은 별도 이벤트로 남기세요.');
  }

  async function handleApi(request, response, url) {
    if (!requestOriginAllowed(request)) {
      sendJson(response, 403, { error: '로컬호스트에서 보낸 요청만 처리합니다.' });
      return;
    }
    const body = ['POST', 'PUT', 'PATCH'].includes(request.method) ? await readBody(request, true) : {};
    if (request.method === 'GET' && url.pathname === '/api/status') {
      sendJson(response, 200, { ...summarizeState(readStore(storeFile), baseInput), planSource });
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
      sendJson(response, 200, { ...summarizeState(state, baseInput), planSource });
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
      sendJson(response, 200, { ...summarizeState(state, baseInput), planSource });
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
      sendJson(response, 200, { ...summarizeState(state, baseInput), planSource });
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
      sendJson(response, 200, { ...summarizeState(state, baseInput), planSource });
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
      sendJson(response, 200, { ...summarizeState(state, baseInput), planSource });
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
      sendJson(response, 200, { ...summarizeState(state, baseInput), planSource });
      return;
    }
    sendJson(response, 404, { error: '지원하지 않는 API 경로입니다.' });
  }

  return createHttpServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      handleApi(request, response, url).catch(error => sendJson(response, 400, { error: error.message }));
      return;
    }
    sendStatic(response, resolve(webRoot), url.pathname);
  });
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
  const planInput = inputFile ? readJsonFile(resolve(inputFile)) : readJsonFile(defaultInputPath);
  const planSource = inputFile ? `local_file:${resolve(inputFile)}` : 'synthetic_demo';
  startServer({ port, storeFile, planInput, planSource }).then(({ url }) => {
    console.log(`Challenge Master local web UI: ${url}`);
    console.log(`Store: ${storeFile}`);
    console.log(`Input: ${planSource}`);
  }).catch(error => {
    console.error(`오류: ${error.message}`);
    process.exitCode = 1;
  });
}
