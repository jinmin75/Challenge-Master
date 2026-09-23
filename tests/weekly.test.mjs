import test from 'node:test';
import assert from 'node:assert/strict';
import { planWeek } from '../src/weekly.mjs';

const at = '2026-09-22T01:00:00.000Z';

function task(overrides) {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    kind: overrides.kind ?? 'new',
    minutes: overrides.minutes ?? 10,
    dueDate: overrides.dueDate,
    originalDate: overrides.originalDate,
    prerequisites: overrides.prerequisites,
    splittable: overrides.splittable,
    ready: overrides.ready,
  };
}

function progress(id, taskId, completedMinutes) {
  return {
    id,
    type: 'task_progress_recorded',
    at,
    taskId,
    planVersion: 1,
    completedMinutes,
    learnerConfirmed: true,
  };
}

test('weekly forecast separates observed progress from tentative future allocations', () => {
  const input = {
    days: [
      { date: '2026-09-23', availableMinutes: 20 },
      { date: '2026-09-24', availableMinutes: 20 },
    ],
    tasks: [
      task({ id: 'unit1', title: '첫 단원', kind: 'new', minutes: 20, splittable: true }),
      task({ id: 'unit2', title: '다음 단원', kind: 'new', minutes: 10, prerequisites: ['unit1'], splittable: true }),
    ],
  };

  const result = planWeek(input, { progress: [progress('w1', 'unit1', 8)] });

  assert.deepEqual(result.observedProgress, [{ taskId: 'unit1', minutes: 8, status: 'observed' }]);
  assert.equal(result.totalObservedCompletedMinutes, 8);
  assert.equal(result.totalTentativeMinutes, 22);
  assert.equal(result.tentativeAllocations.every((item) => item.status === 'tentative'), true);
  assert.deepEqual(result.tentativeAllocations.map((item) => item.taskId), ['unit1', 'unit2']);
  assert.deepEqual(result.deferredScope, []);
  assert.equal(result.goalCoverageStatus, 'within_week');
  assert.deepEqual(input.tasks.map((item) => item.minutes), [20, 10]);
});

test('rest days preserve capacity limits and do not duplicate later assignments', () => {
  const result = planWeek({
    days: [
      { date: '2026-09-23', availableMinutes: 60, rest: true },
      { date: '2026-09-24', availableMinutes: 30 },
      { date: '2026-09-25', availableMinutes: 30 },
    ],
    tasks: [
      task({ id: 'unit-a', kind: 'new', minutes: 30, splittable: true }),
      task({ id: 'unit-b', kind: 'review', minutes: 30, splittable: true }),
    ],
  });

  assert.equal(result.days[0].allocatableMinutes, 0);
  assert.equal(result.days[0].assignedMinutes, 0);
  assert.equal(result.days[1].allocatableMinutes, 27);
  assert.equal(result.days[2].allocatableMinutes, 27);
  assert.equal(result.totalAssignedMinutes, 54);
  assert.equal(result.totalAssignedMinutes <= result.totalAllocatableMinutes, true);

  const assignedByTask = sumTentative(result);
  assert.equal(assignedByTask.get('unit-a') + assignedByTask.get('unit-b'), 54);
  assert.equal(result.deferredScope.reduce((sum, item) => sum + item.minutes, 0), 6);
});

test('final deferred scope reports unscheduled work after the week', () => {
  const result = planWeek({
    days: [{ date: '2026-09-23', availableMinutes: 30 }],
    tasks: [
      task({ id: 'essay', title: '긴 답안', kind: 'new', minutes: 40, splittable: true }),
      task({ id: 'review', title: '복습', kind: 'review', minutes: 10 }),
    ],
  });

  assert.equal(result.totalAllocatableMinutes, 27);
  assert.equal(result.totalAssignedMinutes, 27);
  assert.equal(result.deferredScope.length > 0, true);
  assert.equal(result.deferredScope.reduce((sum, item) => sum + item.minutes, 0), 23);
  assert.equal(result.goalCoverageStatus, 'deferred');
  assert.match(result.warning, /미배정 범위/);
});

test('self reports and unconfirmed records do not count as observed completion', () => {
  const result = planWeek({
    days: [{ date: '2026-09-23', availableMinutes: 20 }],
    tasks: [task({ id: 'unit1', kind: 'new', minutes: 10 })],
  }, {
    progress: [
      { id: 'a1', type: 'attempt_recorded', at, taskId: 'unit1', planVersion: 1 },
      { ...progress('w1', 'unit1', 10), learnerConfirmed: false },
    ],
  });

  assert.deepEqual(result.observedProgress, []);
  assert.deepEqual(result.tentativeAllocations.map((item) => item.taskId), ['unit1']);
});

test('invalid progress fails closed', () => {
  assert.throws(() => planWeek({
    days: [{ date: '2026-09-23', availableMinutes: 20 }],
    tasks: [task({ id: 'unit1', kind: 'new', minutes: 10 })],
  }, { progress: [progress('w1', 'missing', 1)] }), /unknown task/i);

  assert.throws(() => planWeek({
    days: [{ date: '2026-09-23', availableMinutes: 20 }],
    tasks: [task({ id: 'unit1', kind: 'new', minutes: 10 })],
  }, { progress: [progress('w1', 'unit1', 11)] }), /exceeds/i);
});

test('weekly plan rejects caller supplied completed task ids', () => {
  assert.throws(() => planWeek({
    days: [{ date: '2026-09-23', availableMinutes: 20 }],
    completedTaskIds: ['unit1'],
    tasks: [task({ id: 'unit1', kind: 'new', minutes: 10 })],
  }), /completedTaskIds/i);
});

test('weekly days must be strictly ascending', () => {
  assert.throws(() => planWeek({
    days: [
      { date: '2026-09-24', availableMinutes: 20 },
      { date: '2026-09-23', availableMinutes: 20 },
    ],
    tasks: [task({ id: 'unit1', kind: 'new', minutes: 10 })],
  }), /ascending/i);
});

test('weekly plan keeps prior task scope and original estimates', () => {
  const priorPlan = {
    date: '2026-09-22',
    planVersion: 1,
    availableMinutes: 60,
    allocatableMinutes: 54,
    assignedMinutes: 20,
    slackMinutes: 6,
    allocations: [{ taskId: 'unit1', title: '첫 단원', kind: 'new', minutes: 20 }],
    deferred: [{ taskId: 'unit2', minutes: 10, reason: 'prerequisite_blocked' }],
    exceptions: [],
    goalCoverageStatus: 'unknown',
    warning: null,
  };
  const base = {
    days: [{ date: '2026-09-23', availableMinutes: 60 }],
    tasks: [
      task({ id: 'unit1', kind: 'new', minutes: 20, splittable: true }),
      task({ id: 'unit2', kind: 'new', minutes: 10, prerequisites: ['unit1'] }),
    ],
  };

  const missing = { ...base, tasks: [base.tasks[0]] };
  assert.throws(() => planWeek(missing, { progress: [], plans: [priorPlan] }), /unit2/i);

  const reduced = structuredClone(base);
  reduced.tasks[0].minutes = 12;
  assert.throws(() => planWeek(reduced, { progress: [], plans: [priorPlan] }), /original task estimate/i);

  assert.equal(planWeek(base, { progress: [], plans: [priorPlan] }).days[0].planVersion, 1);
});

test('duplicate progress event ids are rejected in standalone weekly calls', () => {
  assert.throws(() => planWeek({
    days: [{ date: '2026-09-23', availableMinutes: 20 }],
    tasks: [task({ id: 'unit1', kind: 'new', minutes: 20, splittable: true })],
  }, { progress: [
    progress('w1', 'unit1', 5),
    progress('w1', 'unit1', 5),
  ] }), /duplicate progress event id/i);

  assert.throws(() => planWeek({
    days: [{ date: '2026-09-23', availableMinutes: 20 }],
    tasks: [task({ id: 'unit1', kind: 'new', minutes: 20, splittable: true })],
  }, { progress: [
    progress('w1', 'unit1', 5),
    progress('w1', 'unit1', 6),
  ] }), /duplicate progress event id/i);
});

test('observed progress on a planned day consumes that day capacity', () => {
  const result = planWeek({
    days: [{ date: '2026-09-23', availableMinutes: 60 }],
    tasks: [task({ id: 'unit1', kind: 'new', minutes: 80, splittable: true })],
  }, {
    plans: [{
      date: '2026-09-23',
      planVersion: 1,
      allocations: [{ taskId: 'unit1', title: '첫 단원', kind: 'new', minutes: 20 }],
      deferred: [{ taskId: 'unit1', minutes: 60, reason: 'partial_capacity' }],
    }],
    progress: [progress('w1', 'unit1', 20)],
  });

  assert.equal(result.days[0].availableMinutes, 60);
  assert.equal(result.days[0].allocatableMinutes, 54);
  assert.equal(result.days[0].observedTodayMinutes, 20);
  assert.equal(result.days[0].assignedMinutes, 34);
  assert.equal(result.days[0].observedTodayMinutes + result.days[0].assignedMinutes <= 54, true);
});

test('over-limit observed progress leaves no same-day tentative assignment', () => {
  const result = planWeek({
    days: [{ date: '2026-09-23', availableMinutes: 60 }],
    tasks: [task({ id: 'unit1', kind: 'new', minutes: 100, splittable: true })],
  }, {
    plans: [{
      date: '2026-09-23',
      planVersion: 1,
      allocations: [{ taskId: 'unit1', title: '첫 단원', kind: 'new', minutes: 60 }],
      deferred: [{ taskId: 'unit1', minutes: 40, reason: 'partial_capacity' }],
    }],
    progress: [progress('w1', 'unit1', 60)],
  });

  assert.equal(result.days[0].allocatableMinutes, 54);
  assert.equal(result.days[0].observedTodayMinutes, 60);
  assert.equal(result.days[0].assignedMinutes, 0);
  assert.deepEqual(result.days[0].allocations, []);
});

test('dated progress does not unlock prerequisites before its plan date', () => {
  const result = planWeek({
    days: [
      { date: '2026-09-23', availableMinutes: 60 },
      { date: '2026-09-24', availableMinutes: 60 },
    ],
    tasks: [
      task({ id: 'unit1', kind: 'new', minutes: 20, splittable: true }),
      task({ id: 'unit2', kind: 'new', minutes: 10, prerequisites: ['unit1'] }),
    ],
  }, {
    plans: [{
      date: '2026-09-24',
      planVersion: 2,
      allocations: [{ taskId: 'unit1', title: '첫 단원', kind: 'new', minutes: 20 }],
      deferred: [{ taskId: 'unit2', minutes: 10, reason: 'prerequisite_blocked' }],
    }],
    progress: [{ ...progress('w1', 'unit1', 20), planVersion: 2 }],
  });

  assert.equal(result.days[0].observedTodayMinutes, 0);
  assert.equal(result.days[1].observedTodayMinutes, 20);
  assert.equal(result.days[0].allocations.some((item) => item.taskId === 'unit2'), false);
  assert.equal(result.days[1].allocations.find((item) => item.taskId === 'unit2')?.minutes, 10);
});

test('progress from before the forecast week unlocks already completed prerequisites', () => {
  const result = planWeek({
    days: [{ date: '2026-09-23', availableMinutes: 30 }],
    tasks: [
      task({ id: 'unit1', minutes: 10 }),
      task({ id: 'unit2', minutes: 10, prerequisites: ['unit1'] }),
    ],
  }, {
    plans: [{ date: '2026-09-22', planVersion: 1,
      allocations: [{ taskId: 'unit1', title: 'unit1', kind: 'new', minutes: 10 }],
      deferred: [{ taskId: 'unit2', minutes: 10, reason: 'prerequisite_blocked' }] }],
    progress: [progress('prior', 'unit1', 10)],
  });
  assert.equal(result.days[0].observedTodayMinutes, 0);
  assert.equal(result.days[0].allocations.find(item => item.taskId === 'unit2')?.minutes, 10);
});

function sumTentative(result) {
  const sums = new Map();
  for (const item of result.tentativeAllocations) {
    sums.set(item.taskId, (sums.get(item.taskId) ?? 0) + item.minutes);
  }
  return sums;
}
