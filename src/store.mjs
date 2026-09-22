import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, parse, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyEvent, emptyState } from './events.mjs';

const maxBytes = 5 * 1024 * 1024;

function safePath(file) {
  const full = resolve(file);
  let current = parse(full).root;
  for (const component of full.slice(current.length).split(sep)) {
    current = resolve(current, component);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Store symbolic links are not supported');
  }
  return full;
}

export function readStore(file) {
  const path = safePath(file);
  if (!existsSync(path)) return emptyState();
  try {
    if (statSync(path).size > maxBytes) throw new Error('Store exceeds 5 MiB');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    if (saved.schemaVersion !== 1 || !Array.isArray(saved.events)) throw new Error('Unknown store schema');
    return saved.events.reduce(applyEvent, emptyState());
  } catch (error) {
    throw new Error(`Cannot read store; original data preserved: ${error.message}`, { cause: error });
  }
}

export function appendToStore(file, event) {
  const path = safePath(file);
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  let lockFd;
  try { lockFd = openSync(lock, 'wx', 0o600); }
  catch (error) { throw new Error(`Cannot acquire store lock (${error.code}); no data changed`, { cause: error }); }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let tempFd;
  let tempCreated = false;
  try {
    const before = readStore(path);
    const after = applyEvent(before, event);
    if (after.events.length === before.events.length) return after;
    const data = JSON.stringify({ schemaVersion: 1, events: after.events }, null, 2) + '\n';
    if (Buffer.byteLength(data) > maxBytes) throw new Error('Store exceeds 5 MiB; original data preserved');
    tempFd = openSync(temporary, 'wx', 0o600);
    tempCreated = true;
    writeFileSync(tempFd, data);
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = undefined;
    renameSync(temporary, path);
    tempCreated = false;
    return after;
  } finally {
    if (tempFd !== undefined) closeSync(tempFd);
    if (tempCreated) unlinkSync(temporary);
    closeSync(lockFd);
    unlinkSync(lock);
  }
}
