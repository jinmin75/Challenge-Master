import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyEvent, emptyState } from '../src/events.mjs';
import { planDay } from '../src/scheduler.mjs';
import { planFromProgress } from '../src/replan.mjs';
import { planWeek } from '../src/weekly.mjs';
import { CAUSES, completeBlocker, isNote, noteItems, reviewCycle, reviewDateBlocker, reviewTaskId, reviewTasks,
  saveSession } from '../src/study-core.mjs';

const base = [{ id: 'unit1', title: '새 단원', kind: 'new', minutes: 60, splittable: true }];
const note = (overrides = {}) => saveSession(null, {
  question: '형성평가를 설명하시오.', firstAnswer: '수업 중 평가', mainCause: CAUSES[0], otherCauses: [CAUSES[2], CAUSES[0]],
  reviewDate: '2026-10-01', reviewMinutes: 10, ...overrides,
}, { id: 's1', now: '2026-09-29T10:00:00.000Z' });

function plan(state, date, sessions, { first = false } = {}) {
  const tasks = [...base, ...reviewTasks({ sessions, state, today: date })];
  const input = { date, availableMinutes: 60, tasks };
  const planned = first ? planDay({ ...input, planVersion: 1 }) : planFromProgress(input, state);
  return applyEvent(state, { id: randomUUID(), type: 'plan_created', at: `${date}T09:00:00.000Z`, plan: planned });
}

function record(state, taskId, minutes, date) {
  return applyEvent(state, { id: randomUUID(), type: 'task_progress_recorded', at: `${date}T10:00:00.000Z`, taskId,
    planVersion: state.currentPlan.planVersion, completedMinutes: minutes, learnerConfirmed: true });
}

test('a note has a main cause; other causes exclude it, and review minutes are bounded', () => {
  const session = note();
  assert.equal(isNote(session), true);
  assert.deepEqual(session.otherCauses, [CAUSES[2]]);
  assert.equal(isNote(note({ mainCause: '' })), false);
  assert.throws(() => note({ mainCause: '아무 원인' }), /목록에서 고르세요/);
  assert.throws(() => note({ reviewMinutes: 3 }), /5~120분/);
});

test('a due note enters the day plan as a review task and is done when its minutes are recorded', () => {
  let sessions = [note()];
  assert.deepEqual(reviewTasks({ sessions, state: emptyState(), today: '2026-09-30' }), [], 'not before the review date');
  let state = plan(emptyState(), '2026-10-01', sessions, { first: true });
  const taskId = reviewTaskId('s1', '2026-10-01');
  assert.deepEqual(state.currentPlan.allocations.find(item => item.taskId === taskId)?.minutes, 10,
    'a due review is allocated in full within the review share');
  let cycle = reviewCycle(sessions[0], state, '2026-10-01');
  assert.deepEqual([cycle.planned, cycle.inCurrentPlan, cycle.done], [true, true, false]);
  assert.equal(completeBlocker(cycle), null);
  assert.match(reviewDateBlocker(sessions[0], state, '2026-10-01'), /계획에 들어가 있습니다/);

  state = record(state, taskId, 10, '2026-10-01');
  cycle = reviewCycle(sessions[0], state, '2026-10-01');
  assert.equal(cycle.done, true);
  assert.equal(reviewDateBlocker(sessions[0], state, '2026-10-01'), null, 'the next date can be chosen once done');

  // Next day: the finished task stays in the input (replanning needs it) but is not allocated again.
  sessions = [saveSession(sessions[0], { reviewDate: '2026-10-03' }, { now: '2026-10-01T11:00:00.000Z' })];
  state = plan(state, '2026-10-02', sessions);
  assert.equal(state.currentPlan.allocations.some(item => item.taskId.startsWith('note:')), false);
  // The new review date comes: a new cycle task is added and the plan still replans without errors.
  state = plan(state, '2026-10-03', sessions);
  assert.ok(state.currentPlan.allocations.some(item => item.taskId === reviewTaskId('s1', '2026-10-03')));
  // The weekly forecast accepts the same input.
  const week = planWeek({ days: [{ date: '2026-10-03', availableMinutes: 60 }, { date: '2026-10-04', availableMinutes: 60 }],
    tasks: [...base, ...reviewTasks({ sessions, state, today: '2026-10-03' })], planVersion: state.currentPlan.planVersion + 1 }, state);
  assert.ok(week.tentativeAllocations.length > 0);
});

test('a review that never entered a plan can be marked done directly; a planned one only through today\'s plan', () => {
  const session = note();
  const unplanned = reviewCycle(session, emptyState(), '2026-10-02');
  assert.deepEqual([unplanned.due, unplanned.planned], [true, false]);
  assert.equal(completeBlocker(unplanned), null);
  const marked = { ...session, reviews: [{ dueDate: '2026-10-01', doneAt: '2026-10-02T09:00:00.000Z' }] };
  assert.equal(reviewCycle(marked, emptyState(), '2026-10-02').done, true);
  assert.deepEqual(reviewTasks({ sessions: [marked], state: emptyState(), today: '2026-10-02' }), []);

  // Planned on 10-01, then a new plan version without it (e.g. rest day) → finish it from a replanned day.
  let state = plan(emptyState(), '2026-10-01', [session], { first: true });
  state = applyEvent(state, { id: randomUUID(), type: 'plan_created', at: '2026-10-02T09:00:00.000Z',
    plan: planFromProgress({ date: '2026-10-02', availableMinutes: 60, rest: true,
      tasks: [...base, ...reviewTasks({ sessions: [session], state, today: '2026-10-02' })] }, state) });
  const cycle = reviewCycle(session, state, '2026-10-02');
  assert.equal(cycle.inCurrentPlan, false);
  assert.match(completeBlocker(cycle), /남은 과업 다시 배정/);
  assert.match(completeBlocker(reviewCycle({ ...session, reviewDate: '2026-10-09' }, state, '2026-10-02')), /2026-10-09에/);
  assert.match(completeBlocker(null), /복습일이 없습니다/);
});

test('the 오답노트 lists due reviews first with overdue days', () => {
  const due = note();
  const later = { ...note({ reviewDate: '2026-10-20' }), id: 's2', updatedAt: '2026-09-29T12:00:00.000Z' };
  const plain = { ...note({ mainCause: '' }), id: 's3' };
  const items = noteItems({ sessions: [later, plain, due], state: emptyState(), today: '2026-10-03' });
  assert.deepEqual(items.map(item => item.session.id), ['s1', 's2']);
  assert.equal(items[0].dueNow, true);
  assert.equal(items[0].overdueDays, 2);
  assert.equal(items[1].dueNow, false);
});

test('a due review pushed out of a full review share says so, instead of pointing at an old plan', () => {
  // Six notes due the same day, 10 minutes each: the 60-minute day's review share cannot hold them all.
  const sessions = Array.from({ length: 6 }, (_, index) => saveSession(null, {
    question: `문제 ${index + 1}`, firstAnswer: '답', mainCause: CAUSES[0], reviewDate: '2026-10-01', reviewMinutes: 10,
  }, { id: `n${index + 1}`, now: '2026-09-29T10:00:00.000Z' }));
  const state = plan(emptyState(), '2026-10-01', sessions, { first: true });
  const cycles = sessions.map(session => reviewCycle(session, state, '2026-10-01'));
  const pushed = cycles.filter(cycle => cycle.deferredNow && !cycle.inCurrentPlan);
  assert.ok(pushed.length > 0, 'some reviews are deferred today');
  for (const cycle of pushed) {
    assert.equal(cycle.planned, true);
    assert.match(completeBlocker(cycle), /복습 몫이 차서/);
  }
  assert.equal(cycles.filter(cycle => cycle.inCurrentPlan).every(cycle => completeBlocker(cycle) === null), true);
});
