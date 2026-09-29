// Request rules shared by the local app (src/web.mjs, file store) and the web version (web/local-api.js,
// IndexedDB). No Node or browser APIs: each side supplies storage and passes the state in (D022).
import { buildCalendar } from './calendar.mjs';
import { planFromProgress } from './replan.mjs';
import { planDay } from './scheduler.mjs';
import { planWeek } from './weekly.mjs';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function clone(value) {
  return structuredClone(value);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Calendar events keep the learner's local offset so their date part is the local day.
export function localTimestamp(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  return `${localDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${hours}:${minutes}`;
}

export function addLocalDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function newId() {
  return globalThis.crypto.randomUUID();
}

function eventBase(type) {
  return { id: newId(), type, at: new Date().toISOString() };
}

// ---- Setup (PDF registration form) ----

export function parsePositiveInt(value, field) {
  if (!/^[1-9]\d*$/.test(String(value).trim())) throw new Error(`${field}: 1 이상의 숫자로 적어 주세요.`);
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field}: 1 이상의 숫자로 적어 주세요.`);
  return parsed;
}

function taskKindFromText(value = '') {
  const normalized = value.trim().toLowerCase();
  if (['review', '복습', '확인', '확인·교정'].includes(normalized)) return 'review';
  if (['new', '새 내용', '새내용', '새 범위', '새범위', ''].includes(normalized)) return 'new';
  throw new Error('종류는 「새로 공부」나 「복습」으로 골라 주세요.');
}

function parseSetupTasks(value) {
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error('공부할 것을 하나 이상 적어 주세요.');
  if (lines.length > 30) throw new Error('공부할 것은 30개까지 적을 수 있어요.');
  return lines.map((line, index) => {
    const [titleRaw, minutesRaw, kindRaw] = line.split('|').map(part => part.trim());
    if (!titleRaw) throw new Error(`${index + 1}번째 공부할 것의 이름을 적어 주세요.`);
    if (titleRaw.length > 120) throw new Error(`${index + 1}번째 공부할 것의 이름이 너무 길어요.`);
    const minutes = minutesRaw ? parsePositiveInt(minutesRaw, `${index + 1}번째 공부할 것의 시간`) : 30;
    const kind = taskKindFromText(kindRaw);
    return { title: titleRaw, minutes, kind };
  });
}

// field(name) returns the trimmed text of a form field ('' when missing).
export function parseSetupFields(field) {
  const title = field('title') || '내 학습 자료';
  if (title.length > 120) throw new Error('자료 이름이 너무 길어요.');
  const dailyMinutes = parsePositiveInt(field('dailyMinutes'), '하루 공부 시간');
  // D024: the weekly field is gone from the screen; without it the week holds seven ordinary days.
  const weeklyMinutes = field('weeklyMinutes') ? parsePositiveInt(field('weeklyMinutes'), '이번 주 공부 시간') : dailyMinutes * 7;
  const tasks = parseSetupTasks(field('tasks'));
  // Both page fields left blank: the first 30 pages of the PDF (the reader finds out how many there are).
  if (!field('pageStart') && !field('pageEnd')) return { title, dailyMinutes, weeklyMinutes, tasks, selectedPages: null };
  const start = parsePositiveInt(field('pageStart') || '1', '시작 쪽');
  const end = parsePositiveInt(field('pageEnd') || String(start), '끝 쪽');
  if (end < start) throw new Error('끝 쪽은 시작 쪽보다 앞일 수 없어요.');
  if (end - start + 1 > 30) throw new Error('한 번에 30쪽까지 읽을 수 있어요.');
  const selectedPages = Array.from({ length: end - start + 1 }, (_, index) => start + index);
  return { title, dailyMinutes, weeklyMinutes, tasks, selectedPages };
}

export function safeOriginalName(filename) {
  const base = String(filename || 'source.pdf').split(/[\\/]/).pop() || 'source.pdf';
  const name = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;
}

export function isPdfBytes(bytes) {
  return bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';
}

// The extractor reports in English; students see these messages directly on the setup screen.
export function studentPdfError(message = '') {
  if (message.includes('page outside PDF')) {
    return '끝 쪽이 PDF 전체 쪽수보다 커요. PDF 보기 프로그램에서 전체 쪽수를 확인해 주세요.';
  }
  if (message.includes('encrypted PDF')) return '암호가 걸린 PDF는 넣을 수 없어요.';
  if (message.includes('cannot open PDF') || message.includes('not a PDF')) {
    return 'PDF 파일을 열 수 없어요. 파일이 망가지지 않았는지 확인해 주세요.';
  }
  if (message.includes('exceeds 50 MiB')) return 'PDF 파일이 너무 커요(50MB까지).';
  return `PDF에서 글자를 읽지 못했어요. (${message})`;
}

// Pages that yielded no text (scans or blank pages); the screen must not call them drafts.
export function textlessPages(extraction, selectedPages) {
  return selectedPages.filter(number => !extraction.manifest.pages[String(number)]?.markdown);
}

function weekDaysFromSetup(setup, startDate = new Date()) {
  let remaining = setup.weeklyMinutes;
  return Array.from({ length: 7 }, (_, index) => {
    const availableMinutes = Math.min(setup.dailyMinutes, remaining);
    remaining = Math.max(0, remaining - availableMinutes);
    return {
      date: localDate(addLocalDays(startDate, index)),
      availableMinutes,
      rest: availableMinutes === 0,
    };
  });
}

export function planInputFromSetup(setup) {
  const setupId = setup.id ?? 'setup-legacy';
  const tasks = setup.tasks.map((task, index) => ({
    id: `${setupId}-task-${index + 1}`,
    title: task.title,
    kind: task.kind,
    minutes: task.minutes,
    splittable: true,
  }));
  return {
    date: localDate(),
    availableMinutes: setup.dailyMinutes,
    remainingStudyMinutes: tasks.reduce((sum, task) => sum + task.minutes, 0),
    tasks,
    weekDays: weekDaysFromSetup(setup),
  };
}

function pageStatusList(setup) {
  const summary = setup.source?.extraction?.summary;
  if (!summary) return [];
  // Setups saved before v0.6 have no textlessPages; report their text state as unknown (null).
  const textless = setup.source.extraction.textlessPages;
  return summary.selectedPages.map(number => ({
    pdfPageIndex: number,
    status: summary.failedPages.includes(number) ? 'failed' : 'needs_review',
    hasText: Array.isArray(textless) ? !textless.includes(number) : null,
    reviewRequired: true,
  }));
}

const setupMessages = {
  local: {
    empty: '합성 데모입니다. PDF와 공부 범위를 등록하면 그 설정으로 계획을 만듭니다.',
    archived: '이전 계획 기록은 별도 파일로 보존했고, 새 자료는 빈 계획 기록에서 시작합니다. 추출 초안은 원본 대조 필요 상태입니다.',
    saved: 'PDF 원본과 추출 초안은 이 PC에 저장했습니다. 각 페이지는 원본 대조 필요 상태이며, 검토 전에는 ready나 공부 완료로 반영하지 않습니다.',
  },
  browser: {
    empty: '합성 데모입니다. PDF와 공부 범위를 등록하면 그 설정으로 계획을 만듭니다. 기록은 이 브라우저에만 저장됩니다.',
    archived: '이전 계획 기록은 이 브라우저 안에 따로 보관했고, 새 자료는 빈 계획 기록에서 시작합니다. 추출 초안은 원본 대조 필요 상태입니다.',
    saved: '추출한 글자는 이 브라우저에만 저장했고, PDF 원본은 저장하지 않았습니다. 각 페이지는 원본 대조 필요 상태이며, 검토 전에는 공부 완료로 반영하지 않습니다.',
  },
};

export function publicSetup(setup, storage = 'local') {
  const messages = setupMessages[storage];
  if (!setup) return { configured: false, message: messages.empty };
  return {
    configured: true,
    title: setup.title,
    dailyMinutes: setup.dailyMinutes,
    weeklyMinutes: setup.weeklyMinutes,
    tasks: setup.tasks,
    archiveFile: setup.archiveFile ?? null,
    // A browser setup may have no PDF yet (D024: the textbook can be added later).
    source: !setup.source ? null : {
      originalName: setup.source.originalName,
      sizeBytes: setup.source.sizeBytes,
      extractionStatus: setup.source.extractionStatus,
      selectedPages: setup.source.selectedPages ?? [],
      pages: pageStatusList(setup),
      draftFile: setup.source.extraction?.draftFile ?? null,
      manifestFile: setup.source.extraction?.manifestFile ?? null,
    },
    message: setup.archiveFile ? messages.archived : messages.saved,
  };
}

// ---- Plans and status ----

function parseMinutes(value, field, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value)) throw new Error(`${field}: 숫자로 적어 주세요.`);
  if (allowZero ? value < 0 : value <= 0) throw new Error(`${field}: 적을 수 있는 범위를 넘었어요.`);
  return value;
}

// Late (backfilled) study counts against the remaining work exactly like same-day progress (D020).
export function withLateCredit(state) {
  const late = (state.lateProgress ?? []).map(item => ({
    id: item.id,
    type: 'task_progress_recorded',
    at: item.at,
    taskId: item.taskId,
    planVersion: null,
    completedMinutes: item.minutes,
    learnerConfirmed: true,
    date: item.date,
  }));
  return late.length === 0 ? state : { ...state, progress: [...state.progress, ...late] };
}

export function makeupMinutesOn(state, date) {
  return (state.makeups ?? []).filter(item => item.date === date).reduce((sum, item) => sum + item.minutes, 0);
}

export function planInputFor(requestBody, baseInput, state = null) {
  const input = clone(baseInput);
  input.date = localDate();
  if (requestBody && Object.hasOwn(requestBody, 'date')) input.date = requestBody.date;
  if (requestBody && Object.hasOwn(requestBody, 'availableMinutes')) {
    input.availableMinutes = parseMinutes(requestBody.availableMinutes, 'availableMinutes', { allowZero: true });
  } else if (state) {
    // Make-up time the learner chose for this date (D020) adds to the usual daily time.
    input.availableMinutes += makeupMinutesOn(state, input.date);
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
  const today = localDate();
  const current = state.currentPlan;
  const applyCurrentPlan = day => current?.date === day.date ? {
    ...day,
    availableMinutes: current.availableMinutes,
    rest: current.allocatableMinutes === 0 && current.deferred.some(item => item.reason === 'rest_day'),
  } : day;
  // Make-up time counts on future days; today's current plan already includes it.
  const withMakeup = day => {
    const extra = current?.date === day.date ? 0 : makeupMinutesOn(state, day.date);
    return extra === 0 ? day : { ...day, availableMinutes: day.availableMinutes + extra, rest: false };
  };
  if (Array.isArray(baseInput.weekDays) && baseInput.weekDays.length > 0) {
    return baseInput.weekDays.filter(day => day.date >= today).map(day => withMakeup(applyCurrentPlan({
      date: day.date,
      availableMinutes: day.availableMinutes ?? baseInput.availableMinutes,
      rest: day.rest ?? false,
    })));
  }
  const start = current?.date && current.date > today
    ? new Date(`${current.date}T00:00:00`)
    : new Date();
  return Array.from({ length: 7 }, (_, index) => withMakeup(applyCurrentPlan({
    date: localDate(addLocalDays(start, index)),
    availableMinutes: baseInput.availableMinutes,
  })));
}

export function weeklyForecastFor(baseInput, state) {
  return planWeek({
    days: weeklyDaysFor(baseInput, state),
    tasks: clone(baseInput.tasks),
    nextTwoDaysReviewMinutes: baseInput.nextTwoDaysReviewMinutes ?? null,
    planVersion: (state.currentPlan?.planVersion ?? 0) + 1,
  }, withLateCredit(state));
}

function summarizeState(state, baseInput) {
  const confirmedMinutes = state.progress.reduce((sum, item) => sum + item.completedMinutes, 0);
  const currentPlan = displayPlan(state);
  let weeklyForecast = null;
  let weeklyForecastError = null;
  try {
    weeklyForecast = weeklyForecastFor(baseInput, state);
  } catch (error) {
    weeklyForecastError = `이번 주 미리 보기를 만들지 못했어요: ${error.message}`;
  }
  return {
    currentPlan,
    rawCurrentPlan: state.currentPlan,
    eventCount: state.events.length,
    confirmedProgressMinutes: confirmedMinutes,
    lateProgressMinutes: (state.lateProgress ?? []).reduce((sum, item) => sum + item.minutes, 0),
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

// runtime: { input, source, setup, storage: 'local' | 'browser' }
export function statusFor(state, runtime) {
  return {
    ...summarizeState(state, runtime.input),
    planSource: runtime.source,
    setup: publicSetup(runtime.setup, runtime.storage),
  };
}

function startDateOf(runtime) {
  // The day the plan was set up; a PDF added later does not move it (older setups only have the upload time).
  const at = runtime.setup?.createdAt ?? runtime.setup?.source?.uploadedAt;
  return at ? localDate(new Date(at)) : null;
}

export function calendarFor(state, month, runtime) {
  let forecast = null;
  try { forecast = weeklyForecastFor(runtime.input, state); } catch { /* The calendar still shows recorded days. */ }
  return {
    ...buildCalendar({ state, month, today: localDate(), startDate: startDateOf(runtime), forecast }),
    dailyMinutes: runtime.input.availableMinutes,
  };
}

// ---- Write requests ----

// Store-layer messages are English; these reach students on the calendar screen.
const studentMessages = [
  ['Only past days can be reviewed', '어제까지의 날만 알려 줄 수 있어요.'],
  ['Day already reviewed', '이미 알려 준 날이에요.'],
  ['Day already has study records', '공부한 기록이 있는 날은 「못 했어요」나 「쉬는 날이었어요」로 바꿀 수 없어요.'],
  ['Late progress is only for past days', '나중에 적기는 어제까지의 날에만 할 수 있어요. 오늘 공부는 「오늘」 화면에서 적어 주세요.'],
  ['Day was reviewed as missed or rest', '「못 했어요」나 「쉬는 날이었어요」로 알려 준 날에는 나중에 적을 수 없어요.'],
  ['Late progress exceeds the remaining task estimate', '그 공부에 남은 시간보다 많이 적을 수 없어요.'],
  ['Unknown task or plan version', '계획에 없던 공부예요.'],
  ['Make-up time is only for future days', '채울 날은 내일부터 골라 주세요.'],
  ['Make-up requires a day reviewed as missed', '「못 했어요」로 알려 준 날만 채울 날을 정할 수 있어요.'],
  ['Invalid review status', '알 수 없는 답이에요.'],
];

export function studentError(error) {
  const match = studentMessages.find(([english]) => error.message.includes(english));
  return match ? new Error(match[1], { cause: error }) : error;
}

function requestIdOf(body) {
  if (body.requestId === undefined) return newId();
  if (typeof body.requestId !== 'string' || !uuidV4.test(body.requestId)) {
    throw new Error('requestId는 UUID v4 형식이어야 합니다.');
  }
  return body.requestId;
}

function minutesOf(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field}: 1 이상의 숫자로 적어 주세요.`);
  return value;
}

// Replays of the same requestId return the stored event; a different payload is a conflict.
function once(id, build) {
  return before => {
    const previous = before.events.find(item => item.id === id);
    const event = build(before);
    if (!previous) return { ...event, id };
    const { at: _ignored, ...fresh } = { ...event, id };
    const { at: _stored, ...stored } = previous;
    if (JSON.stringify(Object.entries(stored).sort()) !== JSON.stringify(Object.entries(fresh).sort())) {
      throw new Error('requestId가 다른 기록에 사용됐습니다.');
    }
    return previous;
  };
}

const calendarPaths = new Set(['/api/day-review', '/api/late-progress', '/api/makeup']);
export const writePaths = new Set(['/api/start', '/api/progress', '/api/attempt', '/api/shorten', '/api/rest',
  '/api/skip', ...calendarPaths]);

function monthOf(date) {
  return typeof date === 'string' ? date.slice(0, 7) : localDate().slice(0, 7);
}

// Validates the request and returns a builder: (state before) => event to append. Storage runs the builder
// inside its own transaction and appends the result through applyEvent.
export function eventBuilder(path, body, runtime) {
  const baseInput = runtime.input;
  if (path === '/api/start') {
    return before => {
      const input = planInputFor(body, baseInput, before);
      const plan = before.currentPlan
        ? planFromProgress(input, withLateCredit(before))
        : planDay({ ...input, planVersion: 1 });
      return { ...eventBase('plan_created'), plan };
    };
  }
  if (path === '/api/progress') {
    const minutes = parseMinutes(body.completedMinutes, 'completedMinutes');
    if (body.requestId !== undefined && !uuidV4.test(body.requestId)) {
      throw new Error('requestId는 UUID v4 형식이어야 합니다.');
    }
    return before => {
      const previous = body.requestId && before.events.find(item => item.id === body.requestId);
      if (previous) {
        if (previous.type !== 'task_progress_recorded' || previous.taskId !== body.taskId ||
            previous.completedMinutes !== minutes) throw new Error('requestId가 다른 기록에 사용됐습니다.');
        return previous;
      }
      if (!before.currentPlan) throw new Error('오늘 할 것이 아직 없어요. 「오늘」 화면을 다시 열어 주세요.');
      return {
        ...eventBase('task_progress_recorded'), id: body.requestId ?? newId(),
        taskId: body.taskId,
        planVersion: before.currentPlan.planVersion,
        completedMinutes: minutes,
        learnerConfirmed: true,
      };
    };
  }
  if (path === '/api/attempt') {
    return before => {
      if (!before.currentPlan) throw new Error('오늘 할 것이 아직 없어요. 「오늘」 화면을 다시 열어 주세요.');
      return {
        ...eventBase('attempt_recorded'),
        taskId: body.taskId,
        planVersion: before.currentPlan.planVersion,
        evidenceType: body.evidenceType ?? 'observed_attempt',
        assistanceExposure: body.assistanceExposure ?? 'unknown',
        sourceVersion: body.sourceVersion ?? null,
        response: body.response ?? '',
      };
    };
  }
  if (path === '/api/shorten') {
    const availableMinutes = parseMinutes(body.availableMinutes, 'availableMinutes', { allowZero: true });
    return before => {
      if (!before.currentPlan) throw new Error('오늘 할 것이 아직 없어요. 「오늘」 화면을 다시 열어 주세요.');
      return {
        ...eventBase('plan_created'),
        plan: planFromProgress(planInputFor({ ...body, availableMinutes }, baseInput), withLateCredit(before)),
      };
    };
  }
  if (path === '/api/rest') {
    return before => ({
      ...eventBase('plan_created'),
      plan: before.currentPlan
        ? planFromProgress(planInputFor({ ...body, rest: true }, baseInput), withLateCredit(before))
        : planDay({ ...planInputFor({ ...body, rest: true }, baseInput), planVersion: 1 }),
    });
  }
  if (path === '/api/skip') {
    return before => {
      if (!before.currentPlan) throw new Error('오늘 할 것이 아직 없어요. 「오늘」 화면을 다시 열어 주세요.');
      return {
        ...eventBase('noncompletion_confirmed'),
        taskId: body.taskId,
        planVersion: before.currentPlan.planVersion,
        confirmed: true,
      };
    };
  }
  return calendarEventBuilder(path, body, runtime);
}

function calendarEventBuilder(path, body, runtime) {
  const at = localTimestamp();
  const dailyMinutes = runtime.input.availableMinutes;
  // The store does not know when the learner registered; the calendar shows those days as before_start.
  const assertAfterStart = (state, date) => {
    const start = startDateOf(runtime) ?? state.plans[0]?.date ?? null;
    if (typeof date === 'string' && (start === null || date < start)) {
      throw new Error('계획을 만들기 전의 날은 알려 주거나 나중에 적을 수 없어요.');
    }
  };
  if (path === '/api/day-review') {
    const id = requestIdOf(body);
    return once(id, before => {
      assertAfterStart(before, body.date);
      return { type: 'day_reviewed', at, date: body.date, status: body.status };
    });
  }
  if (path === '/api/late-progress') {
    const id = requestIdOf(body);
    const minutes = minutesOf(body.minutes, '몇 분');
    return once(id, before => {
      assertAfterStart(before, body.date);
      return { type: 'late_progress_recorded', at, date: body.date, taskId: body.taskId, minutes, learnerConfirmed: true };
    });
  }
  if (path === '/api/makeup') {
    const id = requestIdOf(body);
    const minutes = minutesOf(body.minutes, '더할 시간');
    return once(id, before => {
      const planned = makeupMinutesOn(before, body.date);
      const isReplay = before.events.some(item => item.id === id);
      if (!isReplay && planned + minutes > dailyMinutes) {
        throw new Error(`한 날에 더할 수 있는 시간은 하루 공부 시간(${dailyMinutes}분)까지예요. 이미 ${planned}분이 잡혀 있어요.`);
      }
      return { type: 'makeup_scheduled', at, date: body.date, minutes, forDate: body.forDate };
    });
  }
  throw new Error('지원하지 않는 API 경로입니다.');
}

// Calendar writes also return the month they touched, so the page can redraw without a second request.
export function writeResponse(path, body, state, runtime) {
  const status = statusFor(state, runtime);
  if (!calendarPaths.has(path)) return status;
  const month = monthOf(path === '/api/makeup' ? body.forDate : body.date);
  return { ...status, calendar: calendarFor(state, month, runtime) };
}

export function isCalendarPath(path) {
  return calendarPaths.has(path);
}
