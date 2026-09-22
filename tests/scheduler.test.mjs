import test from 'node:test';
import assert from 'node:assert/strict';
import { planDay } from '../src/scheduler.mjs';

const baseDate = '2026-09-22';

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

test('K07 overload keeps B=54, protects 22 new minutes and defers remaining work', () => {
  const result = planDay({
    date: baseDate,
    availableMinutes: 60,
    nextTwoDaysReviewMinutes: 40,
    remainingStudyMinutes: 100,
    tasks: [
      task({ id: 'review-a', kind: 'review', minutes: 60, dueDate: baseDate, splittable: true }),
      task({ id: 'review-b', kind: 'review', minutes: 60, dueDate: baseDate, splittable: true }),
      task({ id: 'new-a', kind: 'new', minutes: 30, splittable: true }),
      task({ id: 'new-b', kind: 'new', minutes: 30, splittable: true }),
    ],
  });

  const newMinutes = result.allocations
    .filter((allocation) => allocation.kind === 'new')
    .reduce((sum, allocation) => sum + allocation.minutes, 0);
  const reviewMinutes = result.allocations
    .filter((allocation) => allocation.kind === 'review')
    .reduce((sum, allocation) => sum + allocation.minutes, 0);

  assert.equal(result.allocatableMinutes, 54);
  assert.equal(result.slackMinutes, 6);
  assert.equal(result.assignedMinutes, 54);
  assert.equal(newMinutes, 22);
  assert.equal(reviewMinutes, 32);
  assert.equal(result.goalCoverageStatus, 'infeasible');
  assert.match(result.warning, /전체 완료 어려움/);
  assert.equal(result.deferred.some((item) => item.reason === 'capacity'), true);
});

test('K08 blocked new work can prioritize ready review and records exception', () => {
  const result = planDay({
    date: baseDate,
    availableMinutes: 60,
    completedTaskIds: [],
    tasks: [
      task({ id: 'new-blocked', kind: 'new', minutes: 20, prerequisites: ['concept-a'] }),
      task({ id: 'review-a', kind: 'review', minutes: 30, dueDate: baseDate }),
    ],
  });

  assert.deepEqual(result.allocations.map((item) => item.taskId), ['review-a']);
  assert.equal(result.deferred.find((item) => item.taskId === 'new-blocked')?.reason, 'prerequisite_blocked');
  assert.equal(result.exceptions.some((message) => /weekly adjustment/i.test(message)), true);
});

test('K08 indivisible long tasks never exceed allocatable budget', () => {
  const tooLong = planDay({
    date: baseDate,
    availableMinutes: 60,
    tasks: [task({ id: 'essay', kind: 'new', minutes: 70, splittable: false })],
  });
  assert.deepEqual(tooLong.allocations, []);
  assert.equal(tooLong.deferred[0].reason, 'over_budget');

  const fits = planDay({
    date: baseDate,
    availableMinutes: 60,
    tasks: [
      task({ id: 'essay', kind: 'new', minutes: 50, splittable: false }),
      task({ id: 'review-a', kind: 'review', minutes: 10 }),
    ],
  });
  assert.deepEqual(fits.allocations.map((item) => item.taskId), ['essay']);
  assert.equal(fits.assignedMinutes, 50);
  assert.equal(fits.deferred.find((item) => item.taskId === 'review-a')?.minutes, 10);
  assert.equal(fits.exceptions.some((message) => /indivisible/i.test(message)), true);
});

test('indivisible reviews cannot cumulatively consume protected new time in overload', () => {
  const result = planDay({
    date: baseDate,
    availableMinutes: 60,
    nextTwoDaysReviewMinutes: 20,
    tasks: [
      task({ id: 'review-a', kind: 'review', minutes: 20, dueDate: baseDate, splittable: false }),
      task({ id: 'review-b', kind: 'review', minutes: 20, dueDate: baseDate, splittable: false }),
      task({ id: 'new-a', kind: 'new', minutes: 40, splittable: true }),
    ],
  });

  const newMinutes = result.allocations
    .filter((allocation) => allocation.kind === 'new')
    .reduce((sum, allocation) => sum + allocation.minutes, 0);
  const reviewMinutes = result.allocations
    .filter((allocation) => allocation.kind === 'review')
    .reduce((sum, allocation) => sum + allocation.minutes, 0);

  assert.deepEqual(result.allocations.map((item) => item.taskId), ['review-a', 'new-a']);
  assert.equal(result.assignedMinutes, 54);
  assert.equal(newMinutes, 34);
  assert.equal(reviewMinutes, 20);
  assert.equal(result.deferred.find((item) => item.taskId === 'review-b')?.reason, 'capacity');
});

test('indivisible reviews cannot cumulatively consume protected new time in normal mode', () => {
  const result = planDay({
    date: baseDate,
    availableMinutes: 60,
    tasks: [
      task({ id: 'review-a', kind: 'review', minutes: 20, dueDate: baseDate, splittable: false }),
      task({ id: 'review-b', kind: 'review', minutes: 20, dueDate: baseDate, splittable: false }),
      task({ id: 'new-a', kind: 'new', minutes: 40, splittable: true }),
    ],
  });

  const newMinutes = result.allocations
    .filter((allocation) => allocation.kind === 'new')
    .reduce((sum, allocation) => sum + allocation.minutes, 0);
  const reviewMinutes = result.allocations
    .filter((allocation) => allocation.kind === 'review')
    .reduce((sum, allocation) => sum + allocation.minutes, 0);

  assert.deepEqual(result.allocations.map((item) => item.taskId), ['review-a', 'new-a']);
  assert.equal(result.assignedMinutes, 54);
  assert.equal(newMinutes, 34);
  assert.equal(reviewMinutes, 20);
  assert.equal(result.deferred.find((item) => item.taskId === 'review-b')?.reason, 'capacity');
  assert.deepEqual(result.exceptions, []);
});

test('large total backlog alone keeps normal 60:40 allocation when review debt fits next two days', () => {
  const result = planDay({
    date: baseDate,
    availableMinutes: 60,
    nextTwoDaysReviewMinutes: 40,
    tasks: [
      task({ id: 'new-a', kind: 'new', minutes: 100, splittable: true }),
      task({ id: 'review-a', kind: 'review', minutes: 30, dueDate: baseDate, splittable: true }),
    ],
  });

  const newMinutes = result.allocations
    .filter((allocation) => allocation.kind === 'new')
    .reduce((sum, allocation) => sum + allocation.minutes, 0);
  const reviewMinutes = result.allocations
    .filter((allocation) => allocation.kind === 'review')
    .reduce((sum, allocation) => sum + allocation.minutes, 0);

  assert.equal(result.allocatableMinutes, 54);
  assert.equal(result.assignedMinutes, 54);
  assert.equal(newMinutes, 33);
  assert.equal(reviewMinutes, 21);
});

test("K09 confirmed missed day keeps today's time cap and preserves carryover", () => {
  const result = planDay({
    date: baseDate,
    availableMinutes: 30,
    tasks: [
      task({ id: 'missed-review', kind: 'review', minutes: 25, originalDate: '2026-09-21' }),
      task({ id: 'today-new', kind: 'new', minutes: 25, originalDate: baseDate }),
    ],
  });

  assert.equal(result.allocatableMinutes, 27);
  assert.equal(result.assignedMinutes <= 27, true);
  assert.equal(result.deferred.reduce((sum, item) => sum + item.minutes, 0) > 0, true);
});

test('K18 infeasible plan preserves unscheduled scope without changing time or goal', () => {
  const result = planDay({
    date: baseDate,
    availableMinutes: 40,
    remainingStudyMinutes: 50,
    tasks: [
      task({ id: 'unit-a', kind: 'new', minutes: 20 }),
      task({ id: 'unit-b', kind: 'new', minutes: 20 }),
      task({ id: 'unit-c', kind: 'review', minutes: 40 }),
    ],
  });

  assert.equal(result.allocatableMinutes, 36);
  assert.equal(result.availableMinutes, 40);
  assert.equal(result.goalCoverageStatus, 'infeasible');
  assert.match(result.warning, /임시 진행안/);
  assert.equal(result.deferred.reduce((sum, item) => sum + item.minutes, 0) > 0, true);
});

test('rest day schedules nothing and preserves all work', () => {
  const result = planDay({
    date: baseDate,
    availableMinutes: 60,
    rest: true,
    tasks: [task({ id: 'unit-a', kind: 'new', minutes: 20 })],
  });

  assert.equal(result.allocatableMinutes, 0);
  assert.equal(result.assignedMinutes, 0);
  assert.deepEqual(result.allocations, []);
  assert.equal(result.deferred[0].reason, 'rest_day');
});

test('deterministic pure function does not mutate inputs', () => {
  const tasks = [
    task({ id: 'review-a', kind: 'review', minutes: 10, dueDate: baseDate }),
    task({ id: 'new-a', kind: 'new', minutes: 10 }),
  ];
  const before = structuredClone(tasks);
  const first = planDay({ date: baseDate, availableMinutes: 30, tasks });
  const second = planDay({ date: baseDate, availableMinutes: 30, tasks });

  assert.deepEqual(first, second);
  assert.deepEqual(tasks, before);
});

test('unready tasks are not scheduled', () => {
  const result = planDay({
    date: baseDate,
    availableMinutes: 60,
    tasks: [
      task({ id: 'not-ready', kind: 'new', minutes: 10, ready: false }),
      task({ id: 'ready-review', kind: 'review', minutes: 10 }),
    ],
  });

  assert.deepEqual(result.allocations.map((item) => item.taskId), ['ready-review']);
  assert.equal(result.deferred.find((item) => item.taskId === 'not-ready')?.reason, 'not_ready');
});

test('future review does not displace available new work', () => {
  const result = planDay({
    date: baseDate,
    availableMinutes: 60,
    tasks: [
      task({ id: 'future-review', kind: 'review', minutes: 30, dueDate: '2026-09-30' }),
      task({ id: 'today-new', kind: 'new', minutes: 30 }),
    ],
  });

  assert.deepEqual(result.allocations.map((item) => item.taskId), ['today-new']);
  assert.equal(result.deferred.find((item) => item.taskId === 'future-review')?.reason, 'capacity');
});

test('explicit remaining study minutes sets within-time status when enough budget remains', () => {
  const result = planDay({
    date: baseDate,
    availableMinutes: 60,
    remainingStudyMinutes: 40,
    tasks: [task({ id: 'unit-a', kind: 'new', minutes: 20 })],
  });

  assert.equal(result.goalCoverageStatus, 'within_time');
  assert.equal(result.warning, null);
});

test('varied deterministic budgets preserve minutes and never exceed caps', () => {
  for (let seed = 1; seed <= 180; seed += 1) {
    const availableMinutes = 5 + (seed % 96);
    const completedTaskIds = seed % 7 === 0 ? [`done-${seed}`] : [];
    const tasks = Array.from({ length: 7 }, (_, index) => {
      const id = `s${seed}-t${index}`;
      return task({
        id,
        kind: (seed + index) % 3 === 0 ? 'review' : 'new',
        minutes: 1 + ((seed * (index + 3)) % 37),
        dueDate: (seed + index) % 4 === 0 ? baseDate : undefined,
        originalDate: (seed + index) % 5 === 0 ? '2026-09-20' : undefined,
        prerequisites: index === 0 && seed % 6 === 0 ? [`missing-${seed}`] : [],
        splittable: (seed + index) % 5 === 0,
        ready: (seed + index) % 11 !== 0,
      });
    });
    const result = planDay({ date: baseDate, availableMinutes, completedTaskIds, tasks });

    assert.equal(result.assignedMinutes <= result.allocatableMinutes, true);
    assert.equal(result.allocatableMinutes, Math.floor(availableMinutes * 0.9));
    assert.equal(result.slackMinutes, availableMinutes - result.allocatableMinutes);

    for (const item of tasks) {
      const allocated = result.allocations
        .filter((allocation) => allocation.taskId === item.id)
        .reduce((sum, allocation) => sum + allocation.minutes, 0);
      const deferredMinutes = result.deferred
        .filter((entry) => entry.taskId === item.id)
        .reduce((sum, entry) => sum + entry.minutes, 0);
      assert.equal(allocated + deferredMinutes, item.minutes);
    }
  }
});

test('invalid inputs fail closed', () => {
  assert.throws(() => planDay({ date: '2026/09/22', availableMinutes: 60, tasks: [] }), /date/i);
  assert.throws(() => planDay({ date: baseDate, availableMinutes: -1, tasks: [] }), /availableMinutes/i);
  assert.throws(() => planDay({ date: baseDate, availableMinutes: 60.5, tasks: [] }), /availableMinutes/i);
  assert.throws(() => planDay({ date: baseDate, availableMinutes: Number.MAX_SAFE_INTEGER + 1, tasks: [] }), /availableMinutes/i);
  assert.throws(() => planDay({ date: baseDate, availableMinutes: 60, remainingStudyMinutes: Number.MAX_SAFE_INTEGER + 1, tasks: [] }), /remainingStudyMinutes/i);
  assert.throws(() => planDay({ date: baseDate, availableMinutes: 60, tasks: [task({ id: 'x', minutes: Number.MAX_SAFE_INTEGER + 1 })] }), /minutes/i);
  assert.throws(() => planDay({ date: baseDate, availableMinutes: 60, tasks: [task({ id: 'x', minutes: 0 })] }), /minutes/i);
  assert.throws(() => planDay({ date: baseDate, availableMinutes: 60, tasks: [task({ id: 'x' }), task({ id: 'x' })] }), /duplicate/i);
  assert.throws(() => planDay({ date: baseDate, availableMinutes: 60, tasks: [task({ id: 'x', kind: 'practice' })] }), /kind/i);
  assert.throws(() => planDay({ date: baseDate, availableMinutes: 60, completedTaskIds: ['done', 'done'], tasks: [] }), /duplicate/i);
});
