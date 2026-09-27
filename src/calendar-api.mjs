// HTTP routes for the learning calendar (PRD 6.1). Kept apart from web.mjs, which owns the core plan flow.
import { randomUUID } from 'node:crypto';
import { buildCalendar } from './calendar.mjs';
import { appendToStore, readStore } from './store.mjs';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Store-layer messages are English; these reach students on the calendar screen.
const studentMessages = [
  ['Only past days can be reviewed', '어제까지의 날짜만 확인할 수 있습니다.'],
  ['Day already reviewed', '이미 확인한 날짜입니다.'],
  ['Day already has study records', '공부 기록이 있는 날은 누락이나 휴식으로 확인할 수 없습니다.'],
  ['Late progress is only for past days', '사후 기록은 어제까지의 날짜에만 남길 수 있습니다. 오늘 공부는 「실제 공부 시간 기록」에 적어 주세요.'],
  ['Day was reviewed as missed or rest', '누락이나 휴식으로 확인한 날에는 사후 기록을 남길 수 없습니다.'],
  ['Late progress exceeds the remaining task estimate', '그 과업의 남은 분량보다 많이 적을 수 없습니다.'],
  ['Unknown task or plan version', '계획에 없던 과업입니다.'],
  ['Make-up time is only for future days', '보완할 날은 내일 이후로 골라 주세요.'],
  ['Make-up requires a day reviewed as missed', '누락으로 확인한 날에만 보완 계획을 잡을 수 있습니다.'],
  ['Invalid review status', '확인 종류가 올바르지 않습니다.'],
];

function studentError(error) {
  const match = studentMessages.find(([english]) => error.message.includes(english));
  return match ? new Error(match[1], { cause: error }) : error;
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

function requestId(body) {
  if (body.requestId === undefined) return randomUUID();
  if (typeof body.requestId !== 'string' || !uuidV4.test(body.requestId)) {
    throw new Error('requestId는 UUID v4 형식이어야 합니다.');
  }
  return body.requestId;
}

function minutesOf(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field}은 1 이상의 정수로 적어 주세요.`);
  return value;
}

// Replays of the same requestId return the stored event; a different payload is a conflict.
function appendOnce(storeFile, id, build) {
  return appendToStore(storeFile, before => {
    const previous = before.events.find(item => item.id === id);
    const event = build(before);
    if (!previous) return { ...event, id };
    const { at: _ignored, ...fresh } = { ...event, id };
    const { at: _stored, ...stored } = previous;
    if (JSON.stringify(Object.entries(stored).sort()) !== JSON.stringify(Object.entries(fresh).sort())) {
      throw new Error('requestId가 다른 기록에 사용됐습니다.');
    }
    return previous;
  });
}

export async function handleCalendarApi({ request, url, body, storeFile, dailyMinutes, startDate, forecastFor, status, send }) {
  const calendarFor = (state, month) => {
    let forecast = null;
    try { forecast = forecastFor(state); } catch { /* The calendar still shows recorded days. */ }
    return { ...buildCalendar({ state, month, today: localDate(), startDate, forecast }), dailyMinutes };
  };
  // The store does not know when the learner registered; the calendar shows those days as before_start.
  const assertAfterStart = (state, date) => {
    const start = startDate ?? state.plans[0]?.date ?? null;
    if (typeof date === 'string' && (start === null || date < start)) {
      throw new Error('공부 계획을 등록하기 전 날짜에는 확인이나 사후 기록을 남길 수 없습니다.');
    }
  };
  const respond = (state, month) => send(200, { ...status(state), calendar: calendarFor(state, month) });
  const monthOf = date => (typeof date === 'string' ? date.slice(0, 7) : localDate().slice(0, 7));

  if (request.method === 'GET' && url.pathname === '/api/calendar') {
    const month = url.searchParams.get('month') ?? localDate().slice(0, 7);
    send(200, calendarFor(readStore(storeFile), month));
    return true;
  }
  if (request.method !== 'POST') return false;
  const at = localTimestamp();
  try {
    if (url.pathname === '/api/day-review') {
      const id = requestId(body);
      const state = appendOnce(storeFile, id, before => {
        assertAfterStart(before, body.date);
        return { type: 'day_reviewed', at, date: body.date, status: body.status };
      });
      respond(state, monthOf(body.date));
      return true;
    }
    if (url.pathname === '/api/late-progress') {
      const id = requestId(body);
      const minutes = minutesOf(body.minutes, '공부한 분');
      const state = appendOnce(storeFile, id, before => {
        assertAfterStart(before, body.date);
        return { type: 'late_progress_recorded', at, date: body.date, taskId: body.taskId, minutes, learnerConfirmed: true };
      });
      respond(state, monthOf(body.date));
      return true;
    }
    if (url.pathname === '/api/makeup') {
      const id = requestId(body);
      const minutes = minutesOf(body.minutes, '더할 시간');
      const state = appendOnce(storeFile, id, before => {
        const planned = makeupMinutesOn(before, body.date);
        const isReplay = before.events.some(item => item.id === id);
        if (!isReplay && planned + minutes > dailyMinutes) {
          throw new Error(`한 날짜에 더할 수 있는 보완 시간은 하루 공부 시간(${dailyMinutes}분)까지입니다. 이미 ${planned}분이 잡혀 있습니다.`);
        }
        return { type: 'makeup_scheduled', at, date: body.date, minutes, forDate: body.forDate };
      });
      respond(state, monthOf(body.forDate));
      return true;
    }
  } catch (error) {
    throw studentError(error);
  }
  return false;
}
