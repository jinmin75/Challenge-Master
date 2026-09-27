import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { browserCommand, defaultDataRoot } from '../src/platform.mjs';
import { plantableLink } from '../src/store.mjs';

test('store paths refuse user-made links but accept root-owned system links outside Windows', () => {
  const link = uid => ({ isSymbolicLink: () => true, uid });
  const folder = { isSymbolicLink: () => false, uid: 501 };
  assert.equal(plantableLink(link(0), 'darwin'), false);
  assert.equal(plantableLink(link(501), 'darwin'), true);
  assert.equal(plantableLink(link(1000), 'linux'), true);
  assert.equal(plantableLink(link(0), 'win32'), true);
  assert.equal(plantableLink(folder, 'darwin'), false);
});

test('records go to each platform\'s per-user data folder, never the app folder', () => {
  assert.equal(defaultDataRoot('win32', { LOCALAPPDATA: join('C:', 'Users', 'kim', 'AppData', 'Local') }, 'unused'),
    join('C:', 'Users', 'kim', 'AppData', 'Local', 'ChallengeMaster'));
  assert.equal(defaultDataRoot('darwin', {}, join('/', 'Users', 'kim')),
    join('/', 'Users', 'kim', 'Library', 'Application Support', 'ChallengeMaster'));
  assert.equal(defaultDataRoot('linux', {}, join('/', 'home', 'kim')),
    join('/', 'home', 'kim', '.local', 'share', 'ChallengeMaster'));
});

test('the local page opens with the platform browser handler and the URL as one argument', () => {
  const url = 'http://127.0.0.1:5173/';
  assert.deepEqual(browserCommand('win32', url), ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]);
  assert.deepEqual(browserCommand('darwin', url), ['open', [url]]);
  assert.deepEqual(browserCommand('linux', url), ['xdg-open', [url]]);
});
