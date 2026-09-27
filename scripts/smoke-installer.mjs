import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { children, closeApp, exerciseApp, startApp } from './smoke-app.mjs';

const installedRoot = resolve(process.argv[2] ?? join(tmpdir(), 'ChallengeMasterInstallerSmoke'));
const node = join(installedRoot, 'runtime', 'node', 'node.exe');
const entry = join(installedRoot, 'app', 'src', 'desktop.mjs');
const pdfjsEntry = join(installedRoot, 'app', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs');
const deleteData = process.argv.includes('--uninstall-delete-data');
const testUninstall = deleteData || process.argv.includes('--uninstall');
// Only a throwaway Windows Sandbox may reuse the real per-user data folder or a non-temp install path.
const disposable = process.env.CHALLENGE_MASTER_DISPOSABLE_VM === '1';
const defaultDataRoot = join(process.env.LOCALAPPDATA ?? '', 'ChallengeMaster');
if (deleteData) {
  assert.ok(process.env.LOCALAPPDATA, 'LOCALAPPDATA is required for the delete-data check');
  assert.ok(disposable || !existsSync(defaultDataRoot),
    `Refusing to test record deletion over existing data: ${defaultDataRoot}`);
}
const dataRoot = deleteData ? defaultDataRoot : mkdtempSync(join(tmpdir(), 'challenge-installed-smoke-'));

function assertInside(root, path) {
  const offset = relative(resolve(root), resolve(path));
  assert.ok(offset && offset !== '..' && !offset.startsWith(`..${sep}`));
}

function launch() {
  const env = { ...process.env };
  // The delete-data check must run against the location the uninstaller removes.
  if (deleteData) delete env.CHALLENGE_MASTER_DATA_DIR;
  else env.CHALLENGE_MASTER_DATA_DIR = dataRoot;
  // A PATH without developer tools proves the app needs only its bundled runtime.
  const system = process.env.SystemRoot ?? 'C:\\Windows';
  return startApp({ command: node, args: [entry, '--no-browser'], cwd: join(installedRoot, 'app'),
    env: { ...env, PATH: `${system}\\System32;${system}` } });
}

try {
  for (const file of [node, entry, pdfjsEntry, join(installedRoot, 'Uninstall.exe')]) {
    assert.ok(existsSync(file), `Missing installed file: ${file}`);
  }
  assert.equal(existsSync(join(installedRoot, 'runtime', 'python')), false, 'Python runtime is still bundled');

  const restored = await exerciseApp(launch, dataRoot);

  const shortcut = join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu',
    'Programs', 'Challenge Master', 'Challenge Master.lnk');
  assert.ok(existsSync(shortcut), `Missing Start menu shortcut: ${shortcut}`);
  let runningBlocked = false;
  if (testUninstall) {
    if (!disposable) {
      assertInside(tmpdir(), installedRoot);
      assert.equal(installedRoot, resolve(tmpdir(), 'ChallengeMasterInstallerSmoke'));
    }
    // _?= keeps the uninstaller in place so its exit code reaches this process.
    const third = launch();
    const thirdUrl = await third.ready;
    const blocked = spawnSync(join(installedRoot, 'Uninstall.exe'),
      ['/S', `_?=${installedRoot}`], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(blocked.status, 3, 'Uninstall did not refuse while the app was running');
    assert.ok(existsSync(node), 'Running app was partly removed');
    assert.ok(existsSync(join(dataRoot, 'setup.json')), 'Records changed during a refused uninstall');
    runningBlocked = true;
    await closeApp(thirdUrl, third.child);
    const registered = spawnSync('reg.exe', ['query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ChallengeMaster',
      '/v', 'InstallLocation'], { encoding: 'utf8', windowsHide: true });
    assert.equal(registered.status, 0, registered.stderr);
    assert.ok(registered.stdout.includes(installedRoot), 'Uninstaller registration points elsewhere');
    const removed = spawnSync(join(installedRoot, 'Uninstall.exe'),
      deleteData ? ['/S', '/DELETEDATA'] : ['/S'], {
      encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    assert.equal(removed.status, 0, removed.stderr);
    for (let attempt = 0; attempt < 100 && existsSync(installedRoot); attempt += 1) {
      await new Promise(done => setTimeout(done, 100));
    }
    assert.equal(existsSync(installedRoot), false, 'Installed app folder remains');
    assert.equal(existsSync(shortcut), false, 'Start menu shortcut remains');
    const registrationAfter = spawnSync('reg.exe', ['query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ChallengeMaster'],
    { encoding: 'utf8', windowsHide: true });
    assert.notEqual(registrationAfter.status, 0, 'Uninstall registration remains');
    if (deleteData) {
      for (let attempt = 0; attempt < 100 && existsSync(dataRoot); attempt += 1) {
        await new Promise(done => setTimeout(done, 100));
      }
      assert.equal(existsSync(dataRoot), false, 'Selected record deletion left the data folder');
    } else {
      assert.ok(existsSync(join(dataRoot, 'setup.json')), 'Student setup was removed');
      assert.ok(existsSync(join(dataRoot, 'study-web.json')), 'Student progress was removed');
    }
  }
  console.log(JSON.stringify({ installedRoot, pdfjsBundled: true,
    pdfPages: 1, confirmedProgressMinutes: restored.confirmedProgressMinutes,
    restartPersisted: true, shortcutPresent: true,
    uninstallVerified: testUninstall, runningUninstallBlocked: runningBlocked,
    studentDataPreserved: testUninstall && !deleteData,
    studentDataDeletedOnRequest: deleteData }, null, 2));
} finally {
  for (const child of children) child.kill();
  if (!deleteData) {
    assertInside(tmpdir(), dataRoot);
    rmSync(dataRoot, { recursive: true, force: true });
  }
}
