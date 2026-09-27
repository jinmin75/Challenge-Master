import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { acquire, digest, ensureInside } from './fetch-pinned.mjs';
import { copyAppPayload, PDFJS_VERSION } from './package-app.mjs';

const project = resolve(import.meta.dirname, '..');
const cache = resolve(project, '.cache', 'installer');
const build = mkdtempSync(join(tmpdir(), 'challenge-master-installer-'));
const stage = resolve(build, 'stage');
const tools = resolve(build, 'tools');
const dist = resolve(project, 'dist');
const version = JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unsupported package version: ${version}`);
const output = resolve(dist, `Challenge-Master-Setup-${version}-win-x64.exe`);
const localOutput = resolve(build, `Challenge-Master-Setup-${version}-win-x64.exe`);

const artifacts = [
  {
    name: 'node-v24.21.0-win-x64.zip',
    url: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip',
    sha256: '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
  },
  {
    name: 'nsis-3.12.zip',
    url: 'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.12/nsis-3.12.zip',
    sha256: '56581f90db321581c5381193d796fffcf2d24b2f8fed2160a6c6a3baa67f2c4f',
  },
];

function extract(archive, directory) {
  mkdirSync(directory, { recursive: true });
  // Git Bash puts GNU tar first on PATH, which reads 'H:' as a remote host.
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const result = spawnSync(tar, ['-xf', archive, '-C', directory], {
    encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not extract ${archive}: ${result.stderr || result.error?.message}`);
  }
}

function copyFile(source, target) {
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, readFileSync(source));
}

function findFile(root, name) {
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return path;
      if (entry.isDirectory()) pending.push(path);
    }
  }
  throw new Error(`Missing ${name} under ${root}`);
}

function run(executable, args, cwd = project) {
  const result = spawnSync(executable, args, {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 180000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${executable} failed: ${result.stderr || result.stdout || result.error?.message}`);
  }
  return result.stdout.trim();
}

async function main() {
  console.log(`Installer build workspace: ${build}`);
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('This build targets Windows x64 and must run on Windows x64');
  }
  for (const directory of [build, dist]) mkdirSync(directory, { recursive: true });
  const userAgent = `ChallengeMasterInstallerBuilder/${version}`;
  const [nodeZip, nsisZip] = await Promise.all(artifacts.map(item => acquire(cache, item, userAgent)));
  console.log('Verified pinned build archives');

  ensureInside(build, stage);
  if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  const app = join(stage, 'app');
  copyAppPayload(project, app);
  copyFile(join(project, 'packaging', 'launch.vbs'), join(stage, 'launch.vbs'));
  copyFile(join(project, 'packaging', 'THIRD_PARTY_NOTICES.md'), join(stage, 'THIRD_PARTY_NOTICES.md'));
  console.log('App payload copied');

  const nodeUnpacked = join(build, 'node-unpacked');
  extract(nodeZip, nodeUnpacked);
  const nodeFolder = resolve(findFile(nodeUnpacked, 'node.exe'), '..');
  const nodeStage = join(stage, 'runtime', 'node');
  copyFile(join(nodeFolder, 'node.exe'), join(nodeStage, 'node.exe'));
  copyFile(join(nodeFolder, 'LICENSE'), join(nodeStage, 'LICENSE'));
  console.log(run(join(nodeStage, 'node.exe'), ['--version']));

  const nsisUnpacked = join(tools, 'nsis');
  extract(nsisZip, nsisUnpacked);
  const makensis = findFile(nsisUnpacked, 'makensis.exe');
  console.log(run(makensis, ['/V2', '/INPUTCHARSET', 'UTF8', `/DSTAGE=${stage}`, `/DVERSION=${version}`,
    `/DOUTPUT=${localOutput}`, join(project, 'packaging', 'challenge-master.nsi')]));
  if (!existsSync(localOutput) || statSync(localOutput).size < 1024 * 1024) {
    throw new Error('Installer output is missing or unexpectedly small');
  }
  copyFile(localOutput, output);
  writeFileSync(`${output}.sha256`, `${digest(output)}  ${basename(output)}\n`, 'utf8');
  console.log(JSON.stringify({ installer: output, bytes: statSync(output).size,
    sha256: digest(output), version, node: '24.21.0', pdfjs: PDFJS_VERSION }, null, 2));
  ensureInside(tmpdir(), build);
  rmSync(build, { recursive: true, force: true });
}

main().catch(error => {
  console.error(`Installer build failed: ${error.message}`);
  process.exitCode = 1;
});
