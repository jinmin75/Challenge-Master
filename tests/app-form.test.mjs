import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// run() disables every control while a request is in flight, and browsers leave disabled
// fields out of FormData. Building the upload inside run() therefore sent an empty form
// from real browsers (found 2026-09-27; Node-based tests never exercised the page script).
test('the setup form is read into FormData before run() disables the controls', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'web', 'app.js'), 'utf8');
  const handler = source.slice(source.indexOf("elements.setupForm.addEventListener('submit'"));
  const formData = handler.indexOf('new FormData(elements.setupForm)');
  const runCall = handler.indexOf('run(async');
  assert.ok(formData > 0, 'setup handler must build FormData from the form');
  assert.ok(runCall > 0, 'setup handler must go through run()');
  assert.ok(formData < runCall, 'FormData must be built before run() disables the fields');
});
