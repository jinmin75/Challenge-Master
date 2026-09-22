import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyState, applyEvent } from '../src/events.mjs';
import { readStore, appendToStore } from '../src/store.mjs';

const at = '2026-09-22T01:00:00.000Z';
const plan = (version = 1) => ({ date: '2026-09-22', planVersion: version,
  availableMinutes: 60, allocatableMinutes: 54, assignedMinutes: 20,
  slackMinutes: 6, allocations: [{ taskId: 'unit1', title: '합성 단원', kind: 'new', minutes: 20 }],
  deferred: [], exceptions: [], goalCoverageStatus: 'unknown', warning: null });
const planned = () => applyEvent(emptyState(), { id: 'p1', type: 'plan_created', at, plan: plan() });
const attempt = { id: 'a1', type: 'attempt_recorded', at, taskId: 'unit1', planVersion: 1,
  evidenceType: 'self_reported_reading', assistanceExposure: 'unknown', sourceVersion: null,
  response: '종이책에서 읽음' };

test('duplicate event is idempotent; conflicting id fails', () => {
  const first = applyEvent(planned(), attempt);
  assert.deepEqual(applyEvent(first, attempt), first);
  assert.throws(() => applyEvent(first, { ...attempt, response: '다른 기록' }), /conflict/i);
  assert.equal(first.attempts.length, 1);
  assert.equal(first.attempts[0].evidenceType, 'self_reported_reading');
  assert.equal('mastery' in first, false);
});

test('K10 notification unknown does not create confirmed noncompletion', () => {
  const next = applyEvent(planned(), { id: 'n1', type: 'notification_observed', at,
    notificationId: 'notice1', deliveryStatus: 'unknown', openedAt: null });
  assert.deepEqual(next.noncompletion, []);
  assert.equal(next.notifications[0].deliveryStatus, 'unknown');
});

test('K17 old feedback remains attached to old plan without overwriting current plan', () => {
  const before = applyEvent(planned(), { id: 'p2', type: 'plan_created', at, plan: plan(2) });
  const next = applyEvent(before, { id: 'f1', type: 'feedback_received', at,
    taskId: 'unit1', planVersion: 1, text: '이전 답안 확인', sourceStatus: 'ready' });
  assert.equal(next.currentPlan.planVersion, 2);
  assert.equal(next.feedback[0].eligibleForCurrentPlan, false);
  assert.equal(next.feedback[0].reason, 'stale_plan');
  assert.deepEqual(before.feedback, []);
});

test('K17 creating a new plan invalidates previously eligible feedback', () => {
  const feedback = applyEvent(planned(), { id: 'f1', type: 'feedback_received', at,
    taskId: 'unit1', planVersion: 1, text: '원래 계획의 답안', sourceStatus: 'ready' });
  assert.equal(feedback.feedback[0].eligibleForCurrentPlan, true);
  const next = applyEvent(feedback, { id: 'p2', type: 'plan_created', at, plan: plan(2) });
  assert.equal(next.feedback[0].eligibleForCurrentPlan, false);
  assert.equal(next.feedback[0].reason, 'stale_plan');
  assert.equal(next.feedback[0].text, '원래 계획의 답안');
});

test('unsupported feedback and invalid events fail closed', () => {
  assert.throws(() => applyEvent(planned(), { ...attempt, taskId: 'missing' }), /task/i);
  assert.throws(() => applyEvent(planned(), { ...attempt, evidenceType: 'mastered' }), /evidence/i);
  assert.throws(() => applyEvent(planned(), { ...attempt, at: 'yesterday' }), /timestamp/i);
  assert.throws(() => applyEvent(planned(), { id: 'x', type: 'run_shell', at }), /type/i);
  assert.throws(() => applyEvent(planned(), { id: 'x', type: 'plan_created', at, plan: plan(1) }), /version/i);
  const next = applyEvent(planned(), { id: 'f1', type: 'feedback_received', at,
    taskId: 'unit1', planVersion: 1, text: '미확인 출처', sourceStatus: 'needs_review' });
  assert.equal(next.feedback[0].eligibleForCurrentPlan, false);
});

test('local store persists, replays and does not reset corrupt data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'challenge-events-'));
  const path = join(dir, 'study.json');
  try {
    assert.deepEqual(readStore(path), emptyState());
    appendToStore(path, { id: 'p1', type: 'plan_created', at, plan: plan() });
    appendToStore(path, attempt);
    assert.equal(readStore(path).attempts.length, 1);
    const bytes = readFileSync(path, 'utf8');
    appendToStore(path, attempt);
    assert.equal(readFileSync(path, 'utf8'), bytes);
    writeFileSync(path, '{broken');
    assert.throws(() => appendToStore(path, attempt), /store/i);
    assert.equal(readFileSync(path, 'utf8'), '{broken');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('locked store never overwrites another writer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'challenge-lock-'));
  const path = join(dir, 'study.json');
  try {
    writeFileSync(`${path}.lock`, 'held');
    assert.throws(() => appendToStore(path, attempt), /lock/i);
    assert.equal(readFileSync(`${path}.lock`, 'utf8'), 'held');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invalid calendar timestamps and plans exceeding policy budget are rejected', () => {
  assert.throws(() => applyEvent(planned(), { ...attempt, at: '2026-02-30T01:00:00Z' }), /timestamp/i);
  const excess = { ...plan(), allocatableMinutes: 60, slackMinutes: 0 };
  assert.throws(() => applyEvent(emptyState(), { id: 'p', type: 'plan_created', at, plan: excess }), /budget/i);
  assert.throws(() => applyEvent(planned(), { ...attempt, token: 'do-not-store' }), /field/i);
});
