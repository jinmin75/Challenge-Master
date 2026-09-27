// Downloads build inputs once into a cache and refuses anything whose SHA-256 differs from the pin.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function ensureInside(root, target) {
  const path = resolve(target);
  const offset = relative(root, path);
  if (offset === '..' || offset.startsWith(`..${sep}`) || offset.includes(`..${sep}`) && path !== root) {
    throw new Error(`Refusing to modify outside ${root}: ${path}`);
  }
  return path;
}

export function digest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export async function acquire(cache, artifact, userAgent) {
  mkdirSync(cache, { recursive: true });
  const file = ensureInside(cache, join(cache, artifact.name));
  if (existsSync(file)) {
    if (digest(file) === artifact.sha256) return file;
    throw new Error(`Cached ${artifact.name} has the wrong SHA-256; remove it manually before retrying`);
  }
  const temporary = `${file}.partial`;
  if (existsSync(temporary)) unlinkSync(temporary);
  const response = await fetch(artifact.url, {
    redirect: 'follow',
    headers: { 'user-agent': userAgent },
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
