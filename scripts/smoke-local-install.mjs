// Installer check on a developer PC: silent install into the temp test folder, then smoke-installer --uninstall.
// Installing overwrites the per-user uninstall registration and Start menu shortcut that a real install shares,
// so this refuses to run while Challenge Master is installed for this user (use npm run test:sandbox instead).
// Usage: node scripts/smoke-local-install.mjs dist/Challenge-Master-Setup-<version>-win-x64.exe
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const registration = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ChallengeMaster';
const installer = resolve(process.argv[2] ?? '');
assert.ok(process.platform === 'win32', 'Windows only');
assert.ok(existsSync(installer), `Installer not found: ${installer}`);

if (spawnSync('reg.exe', ['query', registration], { encoding: 'utf8' }).status === 0) {
  console.error('Challenge Master is installed for this user. The test install would take over its registration '
    + 'and shortcut, so nothing was changed. Uninstall it first or run npm run test:sandbox.');
  process.exit(2);
}

const root = join(tmpdir(), 'ChallengeMasterInstallerSmoke');
assert.ok(!root.includes(' '), 'NSIS /D= takes an unquoted path');
const setup = spawnSync(installer, ['/S', `/D=${root}`], { stdio: 'inherit' });
assert.equal(setup.status, 0, `Installer exited with ${setup.status}`);
const smoke = spawnSync(process.execPath, [join(import.meta.dirname, 'smoke-installer.mjs'), root, '--uninstall'],
  { stdio: 'inherit' });
process.exit(smoke.status ?? 1);
