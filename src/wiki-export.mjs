// Wiki export (D023 A-5) in Moa's layout (WikiIngest.ps1 Write-BuiltInWikiSource and the raw ingest.md):
//   raw/challenge-master/<recordId>/<revision>/{record.json, ingest.md}
//   wiki/자료원본/<stem>-<id8>-<rev8>.md          source note, status "needs_review", verification "user_source"
//   wiki/학습로그/<stem>-<logId8>.md                one note per learning log (Moa kept these inside its app)
//   wiki/자료원본/_챌린지마스터_인덱스.md, wiki/학습로그/_챌린지마스터_학습로그_인덱스.md, logs/challenge-master-export-*.jsonl
// Keys match Moa's; only `kind` and the raw folder name differ so the origin stays visible. Pure (Web Crypto only).
import { LOG_TYPES, sessionTitle, VERIFICATION } from './study-core.mjs';

export const RAW_ROOT = 'raw/challenge-master';
export const NOTE_DIR = 'wiki/자료원본';
export const LOG_DIR = 'wiki/학습로그';
const NOTE_INDEX = `${NOTE_DIR}/_챌린지마스터_인덱스.md`;
const LOG_INDEX = `${LOG_DIR}/_챌린지마스터_학습로그_인덱스.md`;
// Moa's default Wiki status for a learning log (StudyStore.ps1 Get-WikiEntryFromLog).
const NEEDS_REVIEW_TYPES = new Set(['SUPPLEMENT', 'VERIFY', 'QUESTION', 'FOLLOW_UP', 'CORRECTION']);

function yaml(value) {
  return JSON.stringify(String(value ?? ''));
}

function yamlArray(values) {
  return `[${values.map(yaml).join(', ')}]`;
}

// Moa's Get-WikiSafeFileStem.
export function safeStem(title) {
  let stem = String(title ?? '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ').trim().replace(/\.+$/, '');
  stem = stem.replace(/\s+/g, ' ');
  if (!stem) stem = '학습자료';
  return stem.length > 80 ? stem.slice(0, 80).trim() : stem;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

async function sha256(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Only sessions compared with the original are exported; drafts stay in the browser.
export function exportableSessions(sessions) {
  return (sessions ?? []).filter(session => session.locked);
}

function sessionLogs(session, logs) {
  return (logs ?? []).filter(log => log.sessionId === session.id && log.status === 'approved')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// The record a revision is taken from: everything the learner wrote, not bookkeeping timestamps.
function canonicalRecord(session, logs) {
  const { updatedAt: _updated, ...fields } = session;
  return { ...fields, logs: logs.map(({ updatedAt: _logUpdated, ...log }) => log) };
}

function pages(evidence) {
  return evidence.map(ref => `${ref.sourceTitle ?? ''} PDF ${ref.pdfPageIndex}쪽${ref.printedPageLabel ? `(인쇄 ${ref.printedPageLabel}쪽)` : ''}`.trim());
}

function section(title, body) {
  const text = String(body ?? '').trim();
  return text ? [`## ${title}`, '', text, ''] : [];
}

function studyBody(session, logs, logLinks) {
  return [
    ...section('문제', session.question),
    ...section('첫 답안(원문을 보기 전)', session.firstAnswer),
    ...section('대조한 근거', session.evidence.map(ref => [
      `### ${pages([ref])[0]}${ref.truncated ? ' · 앞부분만 저장' : ''}`, '', '```text', ref.text, '```',
    ].join('\n')).join('\n\n')),
    ...section('처음 답에서 빠진 것', session.missing),
    ...section('잘못 알고 있던 것', session.mistaken),
    ...section('아직 확인하지 못한 것', session.unverified),
    ...section('수정 답안', session.revision),
    ...section('오답 원인', session.mainCause
      ? [`- 주된 원인: ${session.mainCause}`, ...(session.otherCauses ?? []).map(cause => `- 함께 나타난 원인: ${cause}`)].join('\n') : ''),
    ...section('다음 연습', session.nextAction),
    ...section('복습 메모', session.reflection),
    ...section('복습일', session.reviewDate),
    ...section('학습 요약', session.summary ? `**${session.summary.title}**\n\n${session.summary.content}` : ''),
    ...section('학습로그', logs.map((log, index) => `- ${LOG_TYPES[log.type].label}: [[${logLinks[index]}]]`).join('\n')),
  ];
}

// Builds every file of an export. `now` is the export time (ISO). Returns files plus one entry per record.
export async function buildWikiExport({ sessions, logs, now }) {
  const files = [];
  const entries = [];
  const noteIndex = ['# Challenge Master 학습 기록', ''];
  const logIndex = ['# Challenge Master 학습로그', ''];
  for (const session of exportableSessions(sessions)) {
    const own = sessionLogs(session, logs);
    const record = canonicalRecord(session, own);
    const revision = await sha256(stable(record));
    const title = sessionTitle(session);
    const rawDir = `${RAW_ROOT}/${session.id}/${revision}`;
    const rawPath = `${rawDir}/ingest.md`;
    const noteStem = `${safeStem(title)}-${session.id.slice(0, 8)}-${revision.slice(0, 8)}`;
    const notePath = `${NOTE_DIR}/${noteStem}.md`;
    const logStems = own.map(log => `${safeStem(log.title)}-${log.id.slice(0, 8)}`);
    const tags = [session.subject, session.mainCause ? '오답노트' : null].filter(Boolean);
    const body = studyBody(session, own, logStems);

    files.push({ path: `${rawDir}/record.json`, content: `${JSON.stringify(record, null, 2)}\n` });
    files.push({ path: rawPath, content: [
      '---',
      'kind: "challenge-master-source"',
      'schema_version: 1',
      `record_id: ${yaml(session.id)}`,
      `revision_sha256: ${yaml(revision)}`,
      `title: ${yaml(title)}`,
      'material_type: "학습실 기록"',
      `subject: ${yaml(session.subject)}`,
      `unit: ${yaml(session.studiedSection)}`,
      `tags: ${yamlArray(tags)}`,
      'source: "Challenge Master 학습실"',
      `source_updated_at: ${yaml(session.updatedAt)}`,
      `ingested_at: ${yaml(now)}`,
      'verification_status: "user_source"',
      '---', '',
      `# ${title}`, '',
      '> 이 문서는 Challenge Master가 보존한 학습자의 학습실 기록입니다. 대조한 근거는 PDF에서 자동으로 뽑은 글자이며 원본과 대조가 필요합니다.', '',
      ...body,
    ].join('\n') });
    files.push({ path: notePath, content: [
      '---',
      'kind: "challenge-master-source-note"',
      `record_id: ${yaml(session.id)}`,
      `revision_sha256: ${yaml(revision)}`,
      'type: "source"',
      `title: ${yaml(title)}`,
      `subject: ${yaml(session.subject)}`,
      `tags: ${yamlArray(tags)}`,
      'status: "needs_review"',
      'verification_status: "user_source"',
      `source_location: ${yaml(rawPath)}`,
      '---', '',
      `# ${title}`, '',
      '> 사용자 원자료를 Wiki에서 찾을 수 있도록 연결한 출처 노트입니다. 내용 확인과 전공별 가공은 학습자가 승인해야 합니다.', '',
      `- 원자료: [[${rawPath}]]`,
      '- 자료 유형: 학습실 기록',
      `- 과목: ${session.subject}`,
      `- 단원: ${session.studiedSection}`,
      '- 사용자 기록 출처: Challenge Master 학습실',
      `- 대조한 근거: ${pages(session.evidence).join(', ')}`, '',
      ...body,
    ].join('\n') });
    noteIndex.push(`- [[${noteStem}]] · ${session.subject} · 학습실 기록 · ${session.updatedAt}`);

    own.forEach((log, index) => {
      const logPath = `${LOG_DIR}/${logStems[index]}.md`;
      files.push({ path: logPath, content: [
        '---',
        'kind: "challenge-master-learning-log"',
        `log_id: ${yaml(log.id)}`,
        `record_id: ${yaml(session.id)}`,
        `type: ${yaml(LOG_TYPES[log.type].wikiType)}`,
        `log_type: ${yaml(log.type)}`,
        `title: ${yaml(log.title)}`,
        `subject: ${yaml(session.subject)}`,
        `tags: ${yamlArray([session.subject, LOG_TYPES[log.type].label].filter(Boolean))}`,
        `status: ${yaml(NEEDS_REVIEW_TYPES.has(log.type) ? 'needs_review' : 'new')}`,
        `verification_status: ${yaml(log.verificationStatus)}`,
        `source_location: ${yaml(log.sourceLocation)}`,
        `source_pages: ${yamlArray(pages(log.sourcePages))}`,
        `created_at: ${yaml(log.createdAt)}`,
        '---', '',
        `# ${log.title}`, '',
        `> 학습자가 승인한 학습로그입니다(${LOG_TYPES[log.type].label} · ${VERIFICATION[log.verificationStatus]}).`, '',
        log.content, '',
        `- 학습 기록: [[${noteStem}]]`,
        log.sourcePages.length > 0 ? `- 근거: ${pages(log.sourcePages).join(', ')}` : null,
      ].filter(line => line !== null).join('\n') });
      logIndex.push(`- [[${logStems[index]}]] · ${LOG_TYPES[log.type].label} · ${session.subject} · ${log.createdAt}`);
    });
    entries.push({ recordId: session.id, revisionSha256: revision, rawPath,
      wikiPaths: [notePath, ...logStems.map(stem => `${LOG_DIR}/${stem}.md`)] });
  }
  if (entries.length > 0) {
    files.push({ path: NOTE_INDEX, content: `${noteIndex.join('\n')}\n` });
    if (logIndex.length > 2) files.push({ path: LOG_INDEX, content: `${logIndex.join('\n')}\n` });
    const stamp = now.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    files.push({ path: `logs/challenge-master-export-${stamp}.jsonl`, content: `${entries.map(entry =>
      JSON.stringify({ event: 'exported', ...entry, exportedAt: now })).join('\n')}\n` });
  }
  return { files, entries };
}

// Checks the export before it is written (moa-lessons #9): relative paths, notes with the required front matter.
export function checkWikiExport(files) {
  const problems = [];
  const required = { 'challenge-master-source-note': ['record_id', 'revision_sha256', 'type', 'title', 'status', 'verification_status', 'source_location'],
    'challenge-master-learning-log': ['log_id', 'record_id', 'type', 'title', 'status', 'verification_status'],
    'challenge-master-source': ['record_id', 'revision_sha256', 'title', 'verification_status'] };
  for (const file of files) {
    if (file.path.startsWith('/') || file.path.split('/').some(part => part === '..' || part === '')) problems.push(`경로 ${file.path}`);
    if (!file.path.endsWith('.md') || file.path.split('/').pop().startsWith('_')) continue;
    const match = /^---\n([\s\S]*?)\n---\n/.exec(file.content);
    if (!match) {
      problems.push(`머리말 없음: ${file.path}`);
      continue;
    }
    const keys = Object.fromEntries(match[1].split('\n').map(line => {
      const at = line.indexOf(':');
      return [line.slice(0, at), line.slice(at + 1).trim()];
    }));
    const kind = JSON.parse(keys.kind ?? '""');
    for (const key of required[kind] ?? ['kind']) {
      if (!(key in keys)) problems.push(`${key} 없음: ${file.path}`);
    }
  }
  return problems;
}
