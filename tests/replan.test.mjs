import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, emptyState } from '../src/events.mjs';
import { planFromProgress } from '../src/replan.mjs';

const at = '2026-09-22T01:00:00.000Z';
const baseInput = () => ({ date: '2026-09-23', availableMinutes: 60, tasks: [
  { id: 'unit1', title: '첫 단원', kind: 'new', minutes: 20, splittable: true },
  { id: 'unit2', title: '다음 단원', kind: 'new', minutes: 10, prerequisites: ['unit1'] }
] });
const firstPlan = { date: '2026-09-22', planVersion: 1, availableMinutes: 60,
  allocatableMinutes: 54, assignedMinutes: 20, slackMinutes: 6,
  allocations: [{ taskId: 'unit1', title: '첫 단원', kind: 'new', minutes: 20 }],
  deferred: [], exceptions: [], goalCoverageStatus: 'unknown', warning: null };
const planned = () => applyEvent(emptyState(), { id: 'p1', type: 'plan_created', at, plan: firstPlan });
const progress = (id, minutes, version = 1) => ({ id, type: 'task_progress_recorded', at,
  taskId: 'unit1', planVersion: version, completedMinutes: minutes, learnerConfirmed: true });

test('partial confirmed work reduces only the next plan task remainder', () => {
  const state = applyEvent(planned(), progress('w1', 8));
  const input = baseInput();
  const before = structuredClone(input);
  const result = planFromProgress(input, state);
  assert.equal(result.planVersion, 2);
  assert.equal(result.allocations.find(item => item.taskId === 'unit1')?.minutes, 12);
  assert.equal(result.deferred.find(item => item.taskId === 'unit2')?.reason, 'prerequisite_blocked');
  assert.deepEqual(input, before);
});

test('reading self report and noncompletion do not imply completed work', () => {
  let state = planned();
  state = applyEvent(state, { id: 'a1', type: 'attempt_recorded', at, taskId: 'unit1',
    planVersion: 1, evidenceType: 'self_reported_reading', assistanceExposure: 'unknown',
    sourceVersion: null, response: '읽었다고 보고함' });
  state = applyEvent(state, { id: 'n1', type: 'noncompletion_confirmed', at,
    taskId: 'unit1', planVersion: 1, confirmed: true });
  const result = planFromProgress(baseInput(), state);
  assert.equal(result.allocations.find(item => item.taskId === 'unit1')?.minutes, 20);
});

test('completed work unlocks a prerequisite without awarding mastery', () => {
  const state = applyEvent(planned(), progress('w1', 20));
  const result = planFromProgress(baseInput(), state);
  assert.deepEqual(result.allocations.map(item => item.taskId), ['unit2']);
  assert.equal('mastery' in state, false);
});

test('progress across plan versions is counted once and incompatible task totals fail', () => {
  let state = applyEvent(planned(), progress('w1', 8));
  const secondPlan = { ...firstPlan, date: '2026-09-23', planVersion: 2,
    assignedMinutes: 12, allocations: [{ ...firstPlan.allocations[0], minutes: 12 }] };
  state = applyEvent(state, { id: 'p2', type: 'plan_created', at, plan: secondPlan });
  state = applyEvent(state, progress('w2', 12, 2));
  assert.deepEqual(planFromProgress(baseInput(), state).allocations.map(item => item.taskId), ['unit2']);
  const smaller = baseInput();
  smaller.tasks[0].minutes = 19;
  assert.throws(() => planFromProgress(smaller, state), /original task estimate/i);
});

test('replan rejects caller-completed task IDs without progress evidence', () => {
  const input = { ...baseInput(), completedTaskIds: ['unit1'] };
  assert.throws(() => planFromProgress(input, planned()), /completedTaskIds/i);
});

test('replan keeps every prior assigned and deferred task in the scope', () => {
  const withDeferred = { ...firstPlan, deferred: [{ taskId: 'unit2', minutes: 10,
    reason: 'prerequisite_blocked' }] };
  const state = applyEvent(emptyState(), { id: 'p1', type: 'plan_created', at, plan: withDeferred });
  const missingDeferred = { ...baseInput(), tasks: [baseInput().tasks[0]] };
  assert.throws(() => planFromProgress(missingDeferred, state), /unit2/i);
  const missingAssigned = { ...baseInput(), tasks: [baseInput().tasks[1]] };
  assert.throws(() => planFromProgress(missingAssigned, state), /unit1/i);
  assert.equal(planFromProgress(baseInput(), state).deferred[0].taskId, 'unit2');
});

test('a completed prerequisite remains in the catalog after more than one replan', () => {
  let state = applyEvent(planned(), progress('w1', 20));
  const second = planFromProgress(baseInput(), state);
  state = applyEvent(state, { id: 'p2', type: 'plan_created', at, plan: second });
  const missingCompleted = { ...baseInput(), date: '2026-09-24', tasks: [baseInput().tasks[1]] };
  assert.throws(() => planFromProgress(missingCompleted, state), /unit1/i);
});

test('replan rejects an already reduced estimate instead of subtracting twice', () => {
  const state = applyEvent(planned(), progress('w1', 8));
  const reduced = baseInput();
  reduced.tasks[0].minutes = 12;
  assert.throws(() => planFromProgress(reduced, state), /original task estimate/i);
});

test('original estimate is kept for tasks introduced in a later plan', () => {
  let state = planned();
  const secondInput = baseInput();
  secondInput.tasks.push({ id: 'unit3', title: '새 과업', kind: 'new', minutes: 9 });
  const second = planFromProgress(secondInput, state);
  state = applyEvent(state, { id: 'p2', type: 'plan_created', at, plan: second });
  const thirdInput = { ...secondInput, date: '2026-09-24', tasks: structuredClone(secondInput.tasks) };
  thirdInput.tasks[2].minutes = 7;
  assert.throws(() => planFromProgress(thirdInput, state), /original task estimate/i);
});
