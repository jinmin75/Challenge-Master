import test from 'node:test';
import assert from 'node:assert/strict';
import { EVIDENCE_TEXT_LIMIT, lockBlocker, lockSession, MAX_EVIDENCE, retakeSession, saveBlocker, saveSession,
  sessionStatus, sessionTitle } from '../src/study-core.mjs';

const now = '2026-09-29T10:00:00.000Z';
const later = '2026-09-29T11:00:00.000Z';
const source = {
  sourceId: 'local-pdf-a', title: '교육학 1회독',
  pages: [
    { pdfPageIndex: 1, printedPageLabel: '12', state: 'draft', text: '형성평가는 학습 중에 한다.' },
    { pdfPageIndex: 2, printedPageLabel: null, state: 'textless', text: '' },
    { pdfPageIndex: 3, printedPageLabel: null, state: 'draft', text: 'x'.repeat(EVIDENCE_TEXT_LIMIT + 5) },
  ],
};
const input = { subject: '교육학', goal: '평가 유형 구분', question: '형성평가와 총괄평가를 비교하시오.',
  firstAnswer: '형성평가는 수업 중, 총괄평가는 끝에.', evidence: [{ sourceId: 'local-pdf-a', pdfPageIndex: 1 }] };

test('a session needs a question and a first answer before it can be saved (answer before looking)', () => {
  assert.equal(saveBlocker({ question: '', firstAnswer: 'a' }), '문제를 먼저 입력하세요.');
  assert.match(saveBlocker({ question: 'q', firstAnswer: '  ' }), /첫 답안을 먼저/);
  assert.throws(() => saveSession(null, { ...input, firstAnswer: '' }, { id: 's1', now }), /첫 답안을 먼저/);
  const saved = saveSession(null, input, { id: 's1', now });
  assert.equal(saved.id, 's1');
  assert.equal(saved.locked, false);
  assert.equal(sessionStatus(saved), '초안 저장');
  assert.equal(sessionTitle(saved), '교육학 · 평가 유형 구분');
});

test('comparison cannot start without evidence, and says why', () => {
  assert.equal(lockBlocker(null), '먼저 1단에서 기록을 저장하세요.');
  const saved = saveSession(null, { ...input, evidence: [] }, { id: 's1', now });
  assert.match(lockBlocker(saved), /1개 이상 고르세요/);
  assert.throws(() => lockSession(saved, source, { now }), /1개 이상 고르세요/);
});

test('locking copies the evidence text and freezes question, first answer and evidence', () => {
  const saved = saveSession(null, { ...input, evidence: [{ sourceId: 'local-pdf-a', pdfPageIndex: 1 },
    { sourceId: 'local-pdf-a', pdfPageIndex: 3 }] }, { id: 's1', now });
  const locked = lockSession(saved, source, { now: later });
  assert.equal(locked.locked, true);
  assert.equal(locked.lockedAt, later);
  assert.deepEqual(locked.evidence[0], { sourceId: 'local-pdf-a', pdfPageIndex: 1, printedPageLabel: '12',
    sourceTitle: '교육학 1회독', text: '형성평가는 학습 중에 한다.', truncated: false });
  assert.equal(locked.evidence[1].text.length, EVIDENCE_TEXT_LIMIT);
  assert.equal(locked.evidence[1].truncated, true);
  assert.equal(sessionStatus(locked), '대조 시작');

  const edited = saveSession(locked, { question: '바꾼 문제', firstAnswer: '바꾼 답', evidence: [],
    missing: '총괄평가의 목적', revision: '고친 답', reviewDate: '2026-10-02' }, { id: 'ignored', now: later });
  assert.equal(edited.question, input.question);
  assert.equal(edited.firstAnswer, input.firstAnswer);
  assert.equal(edited.evidence, locked.evidence);
  assert.equal(edited.missing, '총괄평가의 목적');
  assert.equal(edited.revision, '고친 답');
  assert.equal(edited.reviewDate, '2026-10-02');
  assert.equal(sessionStatus(edited), '수정 중');
});

test('locking refuses evidence that is no longer in the registered source', () => {
  const saved = saveSession(null, { ...input, evidence: [{ sourceId: 'old-pdf', pdfPageIndex: 1 }] }, { id: 's1', now });
  assert.throws(() => lockSession(saved, source, { now }), /지금 교재에서 찾을 수 없습니다/);
  const textless = saveSession(null, { ...input, evidence: [{ sourceId: 'local-pdf-a', pdfPageIndex: 2 }] }, { id: 's2', now });
  assert.throws(() => lockSession(textless, source, { now }), /2단에서 근거를 다시/);
});

test('evidence is limited, unique, and review dates must be dates', () => {
  const many = Array.from({ length: MAX_EVIDENCE + 1 }, (_, index) => ({ sourceId: 'a', pdfPageIndex: index + 1 }));
  assert.throws(() => saveSession(null, { ...input, evidence: many }, { id: 's', now }), /8개까지/);
  assert.throws(() => saveSession(null, { ...input, evidence: [input.evidence[0], input.evidence[0]] }, { id: 's', now }),
    /두 번/);
  assert.throws(() => saveSession(null, { ...input, reviewDate: '다음 주' }, { id: 's', now }), /날짜로/);
  assert.throws(() => saveSession(null, { ...input, question: 'q'.repeat(20001) }, { id: 's', now }), /문제이\(가\) 너무 깁니다/);
});

test('다시 풀기 starts an unlocked session on the same question and pages with empty answers', () => {
  const locked = lockSession(saveSession(null, input, { id: 's1', now }), source, { now });
  const retake = retakeSession({ ...locked, revision: '고친 답', reviewDate: '2026-10-01' }, { id: 's2', now: later });
  assert.equal(retake.parentId, 's1');
  assert.equal(retake.locked, false);
  assert.equal(retake.question, input.question);
  assert.equal(retake.firstAnswer, '');
  assert.equal(retake.revision, '');
  assert.equal(retake.reviewDate, '');
  assert.deepEqual(retake.evidence, [{ sourceId: 'local-pdf-a', pdfPageIndex: 1 }]);
  assert.equal(sessionStatus(retake), '작성 중');
});
