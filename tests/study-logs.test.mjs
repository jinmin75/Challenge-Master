import test from 'node:test';
import assert from 'node:assert/strict';
import { approveSummary, CAUSES, defaultVerification, lockSession, logPrefill, logTitle, MANUAL_LOG_TYPES, retakeSession,
  saveLog, saveSession, sessionStatus, summaryBlocker, summaryDraft } from '../src/study-core.mjs';

const now = '2026-09-29T10:00:00.000Z';
const later = '2026-09-29T12:00:00.000Z';
const source = { sourceId: 'pdf-a', title: '교육학 1회독',
  pages: [{ pdfPageIndex: 1, printedPageLabel: '12', state: 'draft', text: '형성평가는 학습 중에 한다.' }] };

function lockedSession(overrides = {}) {
  const saved = saveSession(null, { subject: '교육학', goal: '평가', studiedSection: '3장', question: '형성평가를 설명하시오.',
    firstAnswer: '수업 중 평가', evidence: [{ sourceId: 'pdf-a', pdfPageIndex: 1 }] }, { id: 's1', now });
  const locked = lockSession(saved, source, { now });
  return saveSession(locked, { missing: '학습 개선 목적', mistaken: '성적을 매기는 평가로 알았다', unverified: '피드백 시점',
    reflection: '목적부터 말하기', mainCause: CAUSES[0], ...overrides }, { now });
}

test('quick log buttons follow Moa plus 오개념 수정, and start from the matching step-3 field', () => {
  assert.deepEqual(MANUAL_LOG_TYPES, ['CONCEPT', 'INSIGHT', 'CORRECTION', 'SUPPLEMENT', 'VERIFY', 'QUESTION', 'NOTE']);
  const session = lockedSession();
  assert.equal(logPrefill('CORRECTION', session), '성적을 매기는 평가로 알았다');
  assert.equal(logPrefill('SUPPLEMENT', session), '학습 개선 목적');
  assert.equal(logPrefill('QUESTION', session), '피드백 시점');
  assert.equal(logPrefill('NOTE', session), '목적부터 말하기');
  assert.equal(logPrefill('CONCEPT', session), '');
  assert.equal(logTitle('CONCEPT', '형성평가  는\n학습 중'), '형성평가 는 학습 중');
  assert.equal(logTitle('CONCEPT', '   '), '핵심 개념');
});

test('a learner-written log is approved at once, grounded when compared evidence exists, and keeps its source pages', () => {
  const session = lockedSession();
  assert.equal(defaultVerification('VERIFY', session), 'needs_verification');
  assert.equal(defaultVerification('CONCEPT', session), 'source_grounded');
  assert.equal(defaultVerification('CONCEPT', { locked: false, evidence: [] }), 'user_confirmed');
  const log = saveLog(null, { type: 'CORRECTION', content: '형성평가는 학습 개선용이다.' }, { id: 'l1', now, session });
  assert.deepEqual([log.status, log.origin, log.verificationStatus, log.sessionId], ['approved', 'manual', 'source_grounded', 's1']);
  assert.equal(log.title, '형성평가는 학습 개선용이다.');
  assert.deepEqual(log.sourcePages, [{ sourceTitle: '교육학 1회독', pdfPageIndex: 1, printedPageLabel: '12' }]);
  assert.equal(log.sourceLocation, '3장');
  const edited = saveLog(log, { type: 'NOTE', title: '고친 제목', content: '고친 내용', verificationStatus: 'user_confirmed' },
    { now: later, session });
  assert.deepEqual([edited.id, edited.type, edited.title, edited.createdAt, edited.updatedAt],
    ['l1', 'CORRECTION', '고친 제목', now, later], 'the type of a saved log stays');
  assert.throws(() => saveLog(null, { type: 'CONCEPT', content: '  ' }, { id: 'l2', now, session }), /내용을 적어/);
  assert.throws(() => saveLog(null, { type: 'NOPE', content: 'x' }, { id: 'l2', now, session }), /유형이 올바르지/);
  assert.throws(() => saveLog(null, { type: 'CONCEPT', content: 'x', verificationStatus: 'maybe' }, { id: 'l2', now, session }),
    /확인 상태/);
});

test('wrapping up needs the comparison and a revised answer; the draft lists material, causes and logs', () => {
  assert.match(summaryBlocker(saveSession(null, { question: 'q', firstAnswer: 'a' }, { id: 's0', now })), /3단에서/);
  assert.match(summaryBlocker(lockedSession()), /수정 답안을 먼저/);
  const session = lockedSession({ revision: '형성평가는 학습을 개선하려는 평가다.' });
  assert.equal(summaryBlocker(session), null);
  const logs = [
    saveLog(null, { type: 'CORRECTION', content: '학습 개선용' }, { id: 'l1', now, session }),
    { ...saveLog(null, { type: 'NOTE', content: '무시한 것' }, { id: 'l2', now, session }), status: 'ignored' },
    { ...saveLog(null, { type: 'NOTE', content: '다른 기록' }, { id: 'l3', now, session }), sessionId: 'other' },
  ];
  const draft = summaryDraft(session, logs);
  assert.equal(draft.title, '교육학 · 평가 학습 요약');
  assert.match(draft.content, /^학습자료: 교육학 3장\n학습목표: 평가\n문제: 형성평가를 설명하시오\./);
  assert.match(draft.content, /오답 원인: 개념을 기억하지 못함/);
  assert.match(draft.content, /\n학습로그:\n- 오개념 수정: 학습 개선용$/);
  assert.doesNotMatch(draft.content, /무시한 것|다른 기록/);
});

test('approving the summary again replaces it (one summary per session), and a retake starts without one', () => {
  const session = lockedSession({ revision: '고친 답' });
  const first = approveSummary(session, { title: '', content: '첫 요약' }, { now });
  assert.equal(first.summary.title, '교육학 · 평가 학습 요약');
  assert.equal(sessionStatus(first), '마무리함');
  const second = approveSummary(first, { title: '새 제목', content: '고친 요약' }, { now: later });
  assert.deepEqual(second.summary, { title: '새 제목', content: '고친 요약', approvedAt: later, firstApprovedAt: now });
  assert.throws(() => approveSummary(first, { content: ' ' }, { now }), /요약 내용을/);
  assert.equal(saveSession(second, { reflection: '메모' }, { now: later }).summary.content, '고친 요약', 'saving keeps it');
  assert.equal(retakeSession(second, { id: 's2', now: later }).summary, null);
});
