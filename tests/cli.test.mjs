import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const run = (...args) => spawnSync(process.execPath, ['src/cli.mjs', ...args], { cwd: root, encoding: 'utf8' });

test('demo produces a bounded synthetic plan without claiming PDF conversion', () => {
  const result = run('demo');
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, 'synthetic_no_models');
  assert.equal(output.plan.assignedMinutes, 54);
  assert.equal(output.plan.goalCoverageStatus, 'infeasible');
  assert.equal(output.pdfConversionImplemented, false);
});

test('CLI saves plan, records reading, and restores from a fresh process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'challenge-cli-'));
  const path = join(dir, 'study.json');
  const eventFile = join(dir, 'event.json');
  try {
    const made = run('plan', 'fixtures/synthetic-plan.json', '--store', path);
    assert.equal(made.status, 0, made.stderr);
    writeFileSync(eventFile, JSON.stringify({ id: 'test-reading', type: 'attempt_recorded',
      at: '2026-09-22T01:00:00.000Z', taskId: 'unit1', planVersion: 1,
      evidenceType: 'self_reported_reading', assistanceExposure: 'unknown', sourceVersion: null, response: '읽음' }));
    assert.equal(run('record', eventFile, '--store', path).status, 0);
    assert.equal(run('record', eventFile, '--store', path).status, 0);
    const restored = JSON.parse(run('status', '--store', path).stdout);
    assert.equal(restored.attempts.length, 1);
    assert.equal(restored.currentPlan.planVersion, 1);
    assert.equal(run('plan', 'fixtures/synthetic-plan.json', '--store', path).status, 1);
    assert.equal(run('replan', 'fixtures/synthetic-plan.json', '--store', path).status, 0);
    assert.equal(JSON.parse(run('status', '--store', path).stdout).currentPlan.planVersion, 2);
    const before = readFileSync(path, 'utf8');
    writeFileSync(eventFile, '{broken');
    assert.equal(run('record', eventFile, '--store', path).status, 1);
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI replans from confirmed progress after a fresh process restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'challenge-replan-'));
  const store = join(dir, 'study.json');
  const firstInput = join(dir, 'first.json');
  const nextInput = join(dir, 'next.json');
  const progressFile = join(dir, 'progress.json');
  const tasks = [
    { id: 'unit1', title: '첫 단원', kind: 'new', minutes: 20, splittable: true },
    { id: 'unit2', title: '다음 단원', kind: 'new', minutes: 10, prerequisites: ['unit1'] }
  ];
  try {
    writeFileSync(firstInput, JSON.stringify({ date: '2026-09-22', availableMinutes: 60, tasks }));
    writeFileSync(nextInput, JSON.stringify({ date: '2026-09-23', availableMinutes: 60, tasks }));
    assert.equal(run('plan', firstInput, '--store', store).status, 0);
    writeFileSync(progressFile, JSON.stringify({ id: 'w1', type: 'task_progress_recorded',
      at: '2026-09-22T01:00:00.000Z', taskId: 'unit1', planVersion: 1,
      completedMinutes: 8, learnerConfirmed: true }));
    assert.equal(run('record', progressFile, '--store', store).status, 0);
    const beforeManualPlan = readFileSync(store, 'utf8');
    const bypass = run('plan', nextInput, '--store', store);
    assert.equal(bypass.status, 1);
    assert.match(bypass.stderr, /replan/i);
    assert.equal(readFileSync(store, 'utf8'), beforeManualPlan);
    const replanned = run('replan', nextInput, '--store', store);
    assert.equal(replanned.status, 0, replanned.stderr);
    const output = JSON.parse(replanned.stdout);
    assert.equal(output.plan.planVersion, 2);
    assert.equal(output.plan.allocations.find(item => item.taskId === 'unit1')?.minutes, 12);
    assert.equal(JSON.parse(run('status', '--store', store).stdout).progress.length, 1);
    const beforeInjectedPlan = readFileSync(store, 'utf8');
    writeFileSync(progressFile, JSON.stringify({ id: 'forged-plan', type: 'plan_created',
      at: '2026-09-23T01:00:00.000Z', plan: output.plan }));
    assert.equal(run('record', progressFile, '--store', store).status, 1);
    assert.equal(readFileSync(store, 'utf8'), beforeInjectedPlan);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bad command and missing explicit store return errors', () => {
  assert.equal(run('unknown').status, 1);
  assert.equal(run('status').status, 1);
  assert.equal(run('record', 'fixtures/synthetic-plan.json').status, 1);
  assert.equal(run('replan', 'fixtures/synthetic-plan.json').status, 1);
  assert.equal(run('demo', '--upload').status, 1);
});

test('stored first plan cannot hide completed prerequisites without an event', () => {
  const dir = mkdtempSync(join(tmpdir(), 'challenge-seed-'));
  const store = join(dir, 'study.json');
  const inputFile = join(dir, 'input.json');
  try {
    writeFileSync(inputFile, JSON.stringify({ date: '2026-09-22', availableMinutes: 60,
      completedTaskIds: ['unit1'], tasks: [
        { id: 'unit1', title: '첫 단원', kind: 'new', minutes: 20 },
        { id: 'unit2', title: '다음 단원', kind: 'new', minutes: 10, prerequisites: ['unit1'] }
      ] }));
    const result = run('plan', inputFile, '--store', store);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /completedTaskIds/i);
    assert.equal(run('status', '--store', store).status, 0);
    assert.equal(JSON.parse(run('status', '--store', store).stdout).plans.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('week command recomputes a tentative forecast from stored explicit progress', () => {
  const dir = mkdtempSync(join(tmpdir(), 'challenge-week-cli-'));
  const store = join(dir, 'study.json');
  const input = join(dir, 'week.json');
  const eventFile = join(dir, 'progress.json');
  try {
    assert.equal(run('plan', 'fixtures/synthetic-plan.json', '--store', store).status, 0);
    writeFileSync(eventFile, JSON.stringify({ id: 'weekly-progress', type: 'task_progress_recorded',
      at: '2026-09-23T01:00:00.000Z', taskId: 'unit1', planVersion: 1,
      completedMinutes: 8, learnerConfirmed: true }));
    assert.equal(run('record', eventFile, '--store', store).status, 0);
    const tasks = JSON.parse(readFileSync(join(root, 'fixtures/synthetic-plan.json'), 'utf8')).tasks;
    writeFileSync(input, JSON.stringify({ days: [
      { date: '2026-09-23', availableMinutes: 60 },
      { date: '2026-09-24', availableMinutes: 60 }
    ], tasks }));
    const before = readFileSync(store, 'utf8');
    const result = run('week', input, '--store', store);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.saved, false);
    assert.deepEqual(output.forecast.observedProgress,
      [{ taskId: 'unit1', minutes: 8, status: 'observed' }]);
    assert.equal(output.forecast.totalAssignedMinutes <= output.forecast.totalAllocatableMinutes, true);
    assert.equal(readFileSync(store, 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
