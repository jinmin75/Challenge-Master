import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEvent, emptyState } from '../src/events.mjs';
import { buildCalendar } from '../src/calendar.mjs';
import { localDate, withLateCredit } from '../src/calendar-api.mjs';
import { planDay } from '../src/scheduler.mjs';
import { planFromProgress } from '../src/replan.mjs';
import { readStore } from '../src/store.mjs';
import { createServer } from '../src/web.mjs';

const input = {
  availableMinutes: 60,
  remainingStudyMinutes: 180,
  tasks: [
    { id: 'unit1', title: '새 단원', kind: 'new', minutes: 60, splittable: true },
    { id: 'review1', title: '복습 확인', kind: 'review', minutes: 120, splittable: true },
  ],
};
const at = date => `${date}T10:00:00+09:00`;

function withPlan(state, date, extra = {}) {
  const plan = planDay({ ...input, date, planVersion: (state.currentPlan?.planVersion ?? 0) + 1, ...extra });
  return applyEvent(state, { id: randomUUID(), type: 'plan_created', at: at(date), plan });
}

function withProgress(state, taskId, minutes, date) {
  return applyEvent(state, { id: randomUUID(), type: 'task_progress_recorded', at: at(date), taskId,
    planVersion: state.currentPlan.planVersion, completedMinutes: minutes, learnerConfirmed: true });
}

// 22 recorded · 23 no record · 24 rest · 25 no record · 26 missed · 27 late · 28 today · 30 make-up for 26
function septemberState() {
  let state = emptyState();
  state = withPlan(state, '2026-09-22');
  state = withProgress(state, 'unit1', 20, '2026-09-22');
  state = withPlan(state, '2026-09-23');
  state = withPlan(state, '2026-09-24', { rest: true });
  state = applyEvent(state, { id: randomUUID(), type: 'day_reviewed', at: at('2026-09-28'),
    date: '2026-09-26', status: 'missed' });
  state = applyEvent(state, { id: randomUUID(), type: 'late_progress_recorded', at: at('2026-09-28'),
    date: '2026-09-27', taskId: 'unit1', minutes: 15, learnerConfirmed: true });
  state = applyEvent(state, { id: randomUUID(), type: 'makeup_scheduled', at: at('2026-09-28'),
    date: '2026-09-30', minutes: 20, forDate: '2026-09-26' });
  return withPlan(state, '2026-09-28');
}

test('the month calendar gives each day one state and sums the month from the records', () => {
  const calendar = buildCalendar({ state: septemberState(), month: '2026-09', today: '2026-09-28', startDate: '2026-09-22' });
  const stateOf = day => calendar.days.find(item => item.date === `2026-09-${day}`).state;
  assert.equal(calendar.days.length, 30);
  assert.equal(stateOf('21'), 'before_start');
  assert.equal(stateOf('22'), 'recorded');
  assert.equal(stateOf('23'), 'needs_review');
  assert.equal(stateOf('24'), 'rest');
  assert.equal(stateOf('25'), 'needs_review');
  assert.equal(stateOf('26'), 'missed');
  assert.equal(stateOf('27'), 'late');
  assert.equal(stateOf('28'), 'today');
  assert.equal(stateOf('30'), 'future');
  const day30 = calendar.days.find(item => item.date === '2026-09-30');
  assert.equal(day30.makeupMinutes, 20);
  assert.equal(calendar.days.find(item => item.date === '2026-09-26').makeupScheduledFor, 20);
  assert.deepEqual(calendar.summary, {
    recordedDays: 1, restDays: 1, needsReviewDays: 2, missedDays: 1, lateDays: 1,
    confirmedMinutes: 20, assignedMinutes: calendar.summary.assignedMinutes, lateMinutes: 15, makeupMinutes: 20,
  });
  assert.deepEqual(calendar.needsReview, ['2026-09-25', '2026-09-23']);
  const gap = calendar.signals.find(signal => signal.kind === 'gap_run');
  assert.deepEqual(gap.dates, ['2026-09-25', '2026-09-26']);
  assert.match(gap.message, /공부하지 않은 날로 보지는 않습니다/);
  assert.ok(calendar.backfillableTasks.some(task => task.taskId === 'unit1' && task.remainingMinutes === 25));
});

test('day reviews, late progress and make-up time are refused outside their rules', () => {
  const state = septemberState();
  const event = fields => ({ id: randomUUID(), at: at('2026-09-28'), ...fields });
  assert.throws(() => applyEvent(state, event({ type: 'day_reviewed', date: '2026-09-28', status: 'missed' })),
    /Only past days/);
  assert.throws(() => applyEvent(state, event({ type: 'day_reviewed', date: '2026-09-22', status: 'missed' })),
    /already has study records/);
  assert.throws(() => applyEvent(state, event({ type: 'day_reviewed', date: '2026-09-26', status: 'rest' })),
    /already reviewed/);
  assert.throws(() => applyEvent(state, event({ type: 'late_progress_recorded', date: '2026-09-26', taskId: 'unit1',
    minutes: 5, learnerConfirmed: true })), /reviewed as missed or rest/);
  assert.throws(() => applyEvent(state, event({ type: 'late_progress_recorded', date: '2026-09-25', taskId: 'unit1',
    minutes: 30, learnerConfirmed: true })), /remaining task estimate/);
  assert.throws(() => applyEvent(state, event({ type: 'late_progress_recorded', date: '2026-09-25', taskId: 'nope',
    minutes: 5, learnerConfirmed: true })), /Unknown task/);
  assert.throws(() => applyEvent(state, event({ type: 'makeup_scheduled', date: '2026-09-28', minutes: 10,
    forDate: '2026-09-26' })), /future days/);
  assert.throws(() => applyEvent(state, event({ type: 'makeup_scheduled', date: '2026-09-30', minutes: 10,
    forDate: '2026-09-25' })), /reviewed as missed/);
  assert.throws(() => applyEvent(state, { id: randomUUID(), at: '2026-09-28T01:00:00Z', type: 'day_reviewed',
    date: '2026-09-25', status: 'missed' }), /local-offset timestamp/);
});

test('late progress counts against remaining work, and all credit together stays within the estimate', () => {
  const state = septemberState();
  // unit1: 20 minutes same-day + 15 minutes late = 35 of 60.
  assert.throws(() => withProgress(state, 'unit1', 30, '2026-09-28'), /remaining task estimate|plan allocation/);
  const next = planFromProgress({ ...input, date: '2026-09-29' }, withLateCredit(state));
  const unit1 = [...next.allocations, ...next.deferred].filter(item => item.taskId === 'unit1')
    .reduce((sum, item) => sum + item.minutes, 0);
  assert.equal(unit1, 25);
  const withoutLate = planFromProgress({ ...input, date: '2026-09-29' }, state);
  const unit1WithoutLate = [...withoutLate.allocations, ...withoutLate.deferred].filter(item => item.taskId === 'unit1')
    .reduce((sum, item) => sum + item.minutes, 0);
  assert.equal(unit1WithoutLate, 40);
});

test('a v0.6 store without calendar records still opens and builds a calendar', () => {
  const folder = mkdtempSync(join(tmpdir(), 'challenge-calendar-legacy-'));
  const file = join(folder, 'study.json');
  let state = emptyState();
  state = withPlan(state, '2026-09-22');
  state = withProgress(state, 'unit1', 10, '2026-09-22');
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, events: state.events }));
  const loaded = readStore(file);
  delete loaded.dayReviews; delete loaded.lateProgress; delete loaded.makeups;
  const calendar = buildCalendar({ state: loaded, month: '2026-09', today: '2026-09-24', startDate: null });
  assert.equal(calendar.days.find(item => item.date === '2026-09-22').state, 'recorded');
  assert.equal(calendar.days.find(item => item.date === '2026-09-23').state, 'needs_review');
  assert.deepEqual(withLateCredit(loaded), loaded);
});

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'challenge-calendar-web-'));
  const server = createServer({ storeFile: join(dir, 'study.json'), planInput: { ...input, date: localDate() } });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body) => {
    const response = await fetch(base + path, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try { await fn(call); } finally { await new Promise(done => server.close(done)); }
}

function offset(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localDate(date);
}

test('calendar API records reviews, late progress and capped make-up time, with Korean errors', async () => {
  await withServer(async call => {
    assert.equal((await call('/api/start', { date: offset(-4) })).status, 200);
    assert.equal((await call('/api/start', { date: offset(-3) })).status, 200);

    const reviewId = randomUUID();
    const reviewed = await call('/api/day-review', { requestId: reviewId, date: offset(-2), status: 'missed' });
    assert.equal(reviewed.status, 200, reviewed.data.error);
    assert.equal(reviewed.data.calendar.days.find(day => day.date === offset(-2)).state, 'missed');
    assert.equal((await call('/api/day-review', { requestId: reviewId, date: offset(-2), status: 'missed' })).status, 200);
    const conflict = await call('/api/day-review', { requestId: reviewId, date: offset(-1), status: 'missed' });
    assert.equal(conflict.status, 400);
    assert.match(conflict.data.error, /requestId가 다른 기록/);

    const today = await call('/api/day-review', { date: offset(0), status: 'missed' });
    assert.match(today.data.error, /어제까지의 날짜만/);
    const beforeStart = await call('/api/day-review', { date: offset(-5), status: 'missed' });
    assert.match(beforeStart.data.error, /등록하기 전 날짜/);
    const lateBeforeStart = await call('/api/late-progress', { date: offset(-5), taskId: 'unit1', minutes: 5 });
    assert.match(lateBeforeStart.data.error, /등록하기 전 날짜/);

    const late = await call('/api/late-progress', { date: offset(-3), taskId: 'unit1', minutes: 15 });
    assert.equal(late.status, 200, late.data.error);
    assert.equal(late.data.lateProgressMinutes, 15);
    const tooMuch = await call('/api/late-progress', { date: offset(-3), taskId: 'unit1', minutes: 60 });
    assert.match(tooMuch.data.error, /남은 분량보다 많이/);

    const makeup = await call('/api/makeup', { forDate: offset(-2), date: offset(2), minutes: 40 });
    assert.equal(makeup.status, 200, makeup.data.error);
    const overCap = await call('/api/makeup', { forDate: offset(-2), date: offset(2), minutes: 30 });
    assert.match(overCap.data.error, /하루 공부 시간\(60분\)까지/);
    const forecastDay = makeup.data.weeklyForecast.days.find(day => day.date === offset(2));
    assert.equal(forecastDay.availableMinutes, 100);

    const month = await call(`/api/calendar?month=${offset(2).slice(0, 7)}`);
    assert.equal(month.status, 200);
    assert.equal(month.data.days.find(day => day.date === offset(2)).makeupMinutes, 40);

    const started = await call('/api/start', { date: offset(2) });
    assert.equal(started.data.rawCurrentPlan.availableMinutes, 100);
  });
});
