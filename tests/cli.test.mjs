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
    assert.equal(run('plan', 'fixtures/synthetic-plan.json', '--store', path).status, 0);
    assert.equal(JSON.parse(run('status', '--store', path).stdout).currentPlan.planVersion, 2);
    const before = readFileSync(path, 'utf8');
    writeFileSync(eventFile, '{broken');
    assert.equal(run('record', eventFile, '--store', path).status, 1);
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bad command and missing explicit store return errors', () => {
  assert.equal(run('unknown').status, 1);
  assert.equal(run('status').status, 1);
  assert.equal(run('record', 'fixtures/synthetic-plan.json').status, 1);
  assert.equal(run('demo', '--upload').status, 1);
});
