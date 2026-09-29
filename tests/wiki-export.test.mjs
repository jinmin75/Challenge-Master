import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWikiExport, checkWikiExport, safeStem } from '../src/wiki-export.mjs';
import { createZip } from '../src/zip-core.mjs';
import { approveSummary, CAUSES, lockSession, saveLog, saveSession } from '../src/study-core.mjs';

const now = '2026-09-29T10:00:00.000Z';
const source = { sourceId: 'pdf-a', title: '교육학 1회독',
  pages: [{ pdfPageIndex: 1, printedPageLabel: '12', state: 'draft', text: '형성평가는 학습 중에 한다.' }] };

function records() {
  let session = saveSession(null, { subject: '교육학', goal: '평가', studiedSection: '3장', question: '형성평가를 설명하시오.',
    firstAnswer: '수업 중 평가', evidence: [{ sourceId: 'pdf-a', pdfPageIndex: 1 }] },
  { id: '11111111-2222-4333-8444-555555555555', now });
  session = lockSession(session, source, { now });
  session = saveSession(session, { mistaken: '성적용으로 알았다', revision: '학습 개선용 평가', mainCause: CAUSES[1] }, { now });
  session = approveSummary(session, { title: '', content: '요약' }, { now });
  const logs = [
    saveLog(null, { type: 'CORRECTION', content: '형성평가는 학습 개선용' }, { id: 'aaaaaaaa-0000-4000-8000-000000000001', now, session }),
    saveLog(null, { type: 'CONCEPT', content: '형성평가: 수업 중' }, { id: 'bbbbbbbb-0000-4000-8000-000000000002', now, session }),
  ];
  const draft = saveSession(null, { question: '아직 대조 안 함', firstAnswer: '초안' }, { id: '99999999-0000-4000-8000-000000000009', now });
  return { sessions: [session, draft], logs };
}

test('safe file stems follow Moa (forbidden characters, trailing dots, 80 characters, fallback)', () => {
  assert.equal(safeStem('a/b:c*?"<>|d.'), 'a b c d');
  assert.equal(safeStem('  '), '학습자료');
  assert.equal(safeStem('가'.repeat(90)).length, 80);
});

test('an export writes Moa-style raw copies, a source note per compared record, and one note per learning log', async () => {
  const { sessions, logs } = records();
  const { files, entries } = await buildWikiExport({ sessions, logs, now });
  assert.equal(entries.length, 1, 'drafts that were never compared stay in the browser');
  const [entry] = entries;
  const rev = entry.revisionSha256;
  assert.match(rev, /^[0-9a-f]{64}$/);
  const paths = files.map(file => file.path);
  assert.ok(paths.includes(`raw/challenge-master/11111111-2222-4333-8444-555555555555/${rev}/record.json`));
  assert.equal(entry.rawPath, `raw/challenge-master/11111111-2222-4333-8444-555555555555/${rev}/ingest.md`);
  const notePath = `wiki/자료원본/교육학 · 평가-11111111-${rev.slice(0, 8)}.md`;
  assert.equal(entry.wikiPaths[0], notePath);
  const note = files.find(file => file.path === notePath).content;
  assert.match(note, /^---\nkind: "challenge-master-source-note"\nrecord_id: "11111111-2222-4333-8444-555555555555"\n/);
  assert.match(note, /\ntype: "source"\n/);
  assert.match(note, /\nstatus: "needs_review"\nverification_status: "user_source"\n/);
  assert.match(note, new RegExp(`\\nsource_location: "raw/challenge-master/11111111-2222-4333-8444-555555555555/${rev}/ingest.md"\\n`));
  assert.match(note, /> 사용자 원자료를 Wiki에서 찾을 수 있도록 연결한 출처 노트입니다\./);
  assert.match(note, /## 오답 원인\n\n- 주된 원인: 비슷한 개념과 혼동함/);
  assert.match(note, /## 학습로그\n\n- 오개념 수정: \[\[형성평가는 학습 개선용-aaaaaaaa\]\]/);
  assert.match(note, /```text\n형성평가는 학습 중에 한다\.\n```/);
  const correction = files.find(file => file.path === 'wiki/학습로그/형성평가는 학습 개선용-aaaaaaaa.md').content;
  assert.match(correction, /\ntype: "misconception"\n/);
  assert.match(correction, /\nstatus: "needs_review"\n/, 'Moa marks corrections for review');
  assert.match(correction, /\nverification_status: "source_grounded"\n/);
  assert.match(correction, new RegExp(`- 학습 기록: \\[\\[교육학 · 평가-11111111-${rev.slice(0, 8)}\\]\\]`));
  const concept = files.find(file => file.path === 'wiki/학습로그/형성평가 수업 중-bbbbbbbb.md').content;
  assert.match(concept, /\nstatus: "new"\n/);
  assert.ok(paths.includes('wiki/자료원본/_챌린지마스터_인덱스.md'));
  assert.ok(paths.includes('wiki/학습로그/_챌린지마스터_학습로그_인덱스.md'));
  assert.ok(paths.includes('logs/challenge-master-export-20260929T100000Z.jsonl'));
  assert.deepEqual(checkWikiExport(files), []);
});

test('the revision follows what the learner wrote, not when it was saved', async () => {
  const { sessions, logs } = records();
  const first = (await buildWikiExport({ sessions, logs, now })).entries[0].revisionSha256;
  const touched = [{ ...sessions[0], updatedAt: '2026-10-01T00:00:00.000Z' }, sessions[1]];
  assert.equal((await buildWikiExport({ sessions: touched, logs, now })).entries[0].revisionSha256, first);
  const edited = [{ ...sessions[0], revision: '다시 고친 답' }, sessions[1]];
  assert.notEqual((await buildWikiExport({ sessions: edited, logs, now })).entries[0].revisionSha256, first);
  assert.deepEqual((await buildWikiExport({ sessions: [sessions[1]], logs: [], now })).files, [], 'nothing to export');
});

test('the format check reports missing front matter and unsafe paths', () => {
  assert.deepEqual(checkWikiExport([{ path: 'wiki/자료원본/a.md', content: '# no front matter' }]), ['머리말 없음: wiki/자료원본/a.md']);
  assert.match(checkWikiExport([{ path: 'wiki/../x.md', content: '---\nkind: "x"\n---\n' }])[0], /경로/);
  assert.deepEqual(checkWikiExport([{ path: 'wiki/자료원본/b.md',
    content: '---\nkind: "challenge-master-source-note"\ntitle: "t"\n---\n' }]).length, 6, 'six of seven keys missing');
});

test('the zip keeps UTF-8 names and contents', () => {
  const zip = createZip([{ path: 'wiki/자료원본/한글.md', content: '# 내용' }, { path: 'raw/a.json', content: '{}' }]);
  const view = new DataView(zip.buffer);
  const end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054B50);
  assert.equal(view.getUint16(end + 10, true), 2);
  let at = view.getUint32(end + 16, true);
  const names = [];
  for (let i = 0; i < 2; i += 1) {
    assert.equal(view.getUint16(at + 8, true) & 0x0800, 0x0800, 'UTF-8 flag');
    const length = view.getUint16(at + 28, true);
    names.push(new TextDecoder().decode(zip.subarray(at + 46, at + 46 + length)));
    at += 46 + length;
  }
  assert.deepEqual(names, ['wiki/자료원본/한글.md', 'raw/a.json']);
  assert.throws(() => createZip([{ path: '../x', content: '' }]), /not allowed/);
});
