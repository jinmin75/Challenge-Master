// Builds "Challenge Master.app" (Apple Silicon + Intel) and zips it. Runs on macOS (GitHub Actions).
// The app is not signed or notarized: students confirm it once in System Settings > Privacy & Security.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquire, digest } from './fetch-pinned.mjs';
import { copyAppPayload, PDFJS_VERSION } from './package-app.mjs';

const NODE_VERSION = '24.21.0';
// SHA-256 from https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
const runtimes = [
  { arch: 'arm64', name: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057' },
  { arch: 'x64', name: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    sha256: '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097' },
];

const project = resolve(import.meta.dirname, '..');
const cache = resolve(project, '.cache', 'macos');
const dist = resolve(project, 'dist');
const version = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).version;
const appName = 'Challenge Master.app';
const output = join(dist, `Challenge-Master-${version}-macos.zip`);

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.error?.message}`);
  }
  return result.stdout.trim();
}

function infoPlist() {
  // LSUIElement: the app has no window of its own; the page opens in the default browser.
  // LSMinimumSystemVersion follows Node.js 24's supported macOS (13.5, per its BUILDING.md).
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Challenge Master</string>
  <key>CFBundleDisplayName</key><string>Challenge Master</string>
  <key>CFBundleIdentifier</key><string>io.github.jinmin75.challengemaster</string>
  <key>CFBundleExecutable</key><string>challenge-master</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>13.5</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('Build the macOS app on macOS (ditto keeps permissions)');
  mkdirSync(dist, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'challenge-master-macos-'));
  const app = join(work, appName);
  const contents = join(app, 'Contents');
  const resources = join(contents, 'Resources');
  copyAppPayload(project, join(resources, 'app'));
  copyFileSync(join(project, 'packaging', 'THIRD_PARTY_NOTICES.md'), join(resources, 'THIRD_PARTY_NOTICES.md'));
  mkdirSync(join(contents, 'MacOS'), { recursive: true });
  const launcher = join(contents, 'MacOS', 'challenge-master');
  copyFileSync(join(project, 'packaging', 'macos', 'challenge-master'), launcher);
  chmodSync(launcher, 0o755);
  writeFileSync(join(contents, 'Info.plist'), infoPlist());

  const userAgent = `ChallengeMasterMacBuilder/${version}`;
  for (const runtime of runtimes) {
    const archive = await acquire(cache, { ...runtime,
      url: `https://nodejs.org/dist/v${NODE_VERSION}/${runtime.name}` }, userAgent);
    const unpacked = join(work, `unpacked-${runtime.arch}`);
    mkdirSync(unpacked);
    run('tar', ['-xzf', archive, '-C', unpacked]);
    const folder = join(unpacked, basename(runtime.name, '.tar.gz'));
    const target = join(resources, 'runtime', `node-${runtime.arch}`);
    mkdirSync(target, { recursive: true });
    copyFileSync(join(folder, 'bin', 'node'), join(target, 'node'));
    chmodSync(join(target, 'node'), 0o755);
    copyFileSync(join(folder, 'LICENSE'), join(target, 'LICENSE'));
    console.log(`node-${runtime.arch}: ${run('file', ['-b', join(target, 'node')])}`);
  }
  run('plutil', ['-lint', join(contents, 'Info.plist')]);

  if (existsSync(output)) rmSync(output);
  // ditto keeps the executable bits and bundle structure that a plain zip tool may drop.
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, output]);
  writeFileSync(`${output}.sha256`, `${digest(output)}  ${basename(output)}\n`);
  console.log(JSON.stringify({ zip: output, bytes: statSync(output).size, sha256: digest(output),
    version, node: NODE_VERSION, pdfjs: PDFJS_VERSION }, null, 2));
  rmSync(work, { recursive: true, force: true });
}

main().catch(error => {
  console.error(`macOS build failed: ${error.message}`);
  process.exitCode = 1;
});
