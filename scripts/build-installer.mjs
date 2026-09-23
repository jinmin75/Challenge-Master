import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

const project = resolve(import.meta.dirname, '..');
const cache = resolve(project, '.cache', 'installer');
const build = mkdtempSync(join(tmpdir(), 'challenge-master-installer-'));
const stage = resolve(build, 'stage');
const tools = resolve(build, 'tools');
const dist = resolve(project, 'dist');
const output = resolve(dist, 'Challenge-Master-Setup-0.4.0-win-x64.exe');
const localOutput = resolve(build, 'Challenge-Master-Setup-0.4.0-win-x64.exe');

const artifacts = [
  {
    name: 'node-v24.21.0-win-x64.zip',
    url: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip',
    sha256: '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
  },
  {
    name: 'python-3.14.7-embeddable-amd64.zip',
    url: 'https://www.python.org/ftp/python/3.14.7/python-3.14.7-embeddable-amd64.zip',
    sha256: '76c3c0384ab3f822486f32450f3a4d20f5d65ad0ec32ee34290971aa0eb817e6',
  },
  {
    name: 'pypdf-6.17.0-py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/c1/08/1e9731038124a9127e1d27848952b86fb32b2f45f8f1b94adc7f0817a6ac/pypdf-6.17.0-py3-none-any.whl',
    sha256: '5bd827266a21553b74d910e350131a6227b72f2ab4209bf372814b8195fa11c5',
  },
  {
    name: 'nsis-3.12.zip',
    url: 'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.12/nsis-3.12.zip',
    sha256: '56581f90db321581c5381193d796fffcf2d24b2f8fed2160a6c6a3baa67f2c4f',
  },
];

function ensureInside(root, target) {
  const path = resolve(target);
  const offset = relative(root, path);
  if (offset === '..' || offset.startsWith(`..${sep}`) || offset.includes(`..${sep}`) && path !== root) {
    throw new Error(`Refusing to modify outside ${root}: ${path}`);
  }
  return path;
}

function digest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function acquire(artifact) {
  const file = ensureInside(cache, join(cache, artifact.name));
  if (existsSync(file)) {
    if (digest(file) === artifact.sha256) return file;
    throw new Error(`Cached ${artifact.name} has the wrong SHA-256; remove it manually before retrying`);
  }
  const temporary = `${file}.partial`;
  if (existsSync(temporary)) unlinkSync(temporary);
  const response = await fetch(artifact.url, {
    redirect: 'follow',
    headers: { 'user-agent': 'ChallengeMasterInstallerBuilder/0.4' },
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok || !response.body) throw new Error(`Download failed: ${artifact.name} HTTP ${response.status}`);
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
    const actual = digest(temporary);
    if (actual !== artifact.sha256) throw new Error(`${artifact.name} SHA-256 mismatch: ${actual}`);
    renameSync(temporary, file);
    return file;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function extract(archive, directory) {
  mkdirSync(directory, { recursive: true });
  const result = spawnSync('tar.exe', ['-xf', archive, '-C', directory], {
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

function copyTree(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) copyFile(from, to);
    else throw new Error(`Unsupported source entry: ${from}`);
  }
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
  for (const directory of [cache, build, dist]) mkdirSync(directory, { recursive: true });
  const downloaded = await Promise.all(artifacts.map(acquire));
  console.log('Verified four pinned build archives');

  ensureInside(build, stage);
  if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const app = join(stage, 'app');
  mkdirSync(app, { recursive: true });
  console.log('Copying app source');
  for (const directory of ['src', 'web']) copyTree(join(project, directory), join(app, directory));
  console.log('App source copied');
  mkdirSync(join(app, 'scripts'), { recursive: true });
  copyFile(join(project, 'scripts', 'pdf_extract.py'), join(app, 'scripts', 'pdf_extract.py'));
  mkdirSync(join(app, 'fixtures'), { recursive: true });
  copyFile(join(project, 'fixtures', 'synthetic-plan.json'), join(app, 'fixtures', 'synthetic-plan.json'));
  copyFile(join(project, 'package.json'), join(app, 'package.json'));
  copyFile(join(project, 'packaging', 'launch.vbs'), join(stage, 'launch.vbs'));
  copyFile(join(project, 'packaging', 'THIRD_PARTY_NOTICES.md'), join(stage, 'THIRD_PARTY_NOTICES.md'));

  const nodeUnpacked = join(build, 'node-unpacked');
  ensureInside(build, nodeUnpacked);
  if (existsSync(nodeUnpacked)) rmSync(nodeUnpacked, { recursive: true, force: true });
  extract(downloaded[0], nodeUnpacked);
  const nodeFolder = resolve(findFile(nodeUnpacked, 'node.exe'), '..');
  const nodeStage = join(stage, 'runtime', 'node');
  mkdirSync(nodeStage, { recursive: true });
  copyFile(join(nodeFolder, 'node.exe'), join(nodeStage, 'node.exe'));
  copyFile(join(nodeFolder, 'LICENSE'), join(nodeStage, 'LICENSE'));

  const pythonStage = join(stage, 'runtime', 'python');
  extract(downloaded[1], pythonStage);
  const pth = findFile(pythonStage, 'python314._pth');
  writeFileSync(pth, 'python314.zip\n.\nLib\\site-packages\n', 'utf8');
  const packages = join(pythonStage, 'Lib', 'site-packages');
  extract(downloaded[2], packages);
  if (!existsSync(join(pythonStage, 'LICENSE.txt'))) throw new Error('Python license missing from official archive');
  if (!existsSync(join(packages, 'pypdf-6.17.0.dist-info', 'licenses', 'LICENSE'))) {
    throw new Error('pypdf license missing from official wheel');
  }
  console.log(run(join(nodeStage, 'node.exe'), ['--version']));
  console.log(run(join(pythonStage, 'python.exe'), ['-c', 'import pypdf; print(pypdf.__version__)']));

  const nsisUnpacked = join(tools, 'nsis');
  ensureInside(build, nsisUnpacked);
  if (existsSync(nsisUnpacked)) rmSync(nsisUnpacked, { recursive: true, force: true });
  extract(downloaded[3], nsisUnpacked);
  const makensis = findFile(nsisUnpacked, 'makensis.exe');
  const outputDir = resolve(localOutput, '..');
  mkdirSync(outputDir, { recursive: true });
  console.log(run(makensis, ['/V2', '/INPUTCHARSET', 'UTF8', `/DSTAGE=${stage}`,
    `/DOUTPUT=${localOutput}`, join(project, 'packaging', 'challenge-master.nsi')]));
  if (!existsSync(localOutput) || statSync(localOutput).size < 1024 * 1024) {
    throw new Error('Installer output is missing or unexpectedly small');
  }
  copyFile(localOutput, output);
  writeFileSync(`${output}.sha256`, `${digest(output)}  ${basename(output)}\n`, 'utf8');
  console.log(JSON.stringify({ installer: output, bytes: statSync(output).size,
    sha256: digest(output), node: '24.21.0', python: '3.14.7', pypdf: '6.17.0' }, null, 2));
  ensureInside(tmpdir(), build);
  rmSync(build, { recursive: true, force: true });
}

main().catch(error => {
  console.error(`Installer build failed: ${error.message}`);
  process.exitCode = 1;
});
