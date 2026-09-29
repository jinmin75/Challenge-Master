import test from 'node:test';
import assert from 'node:assert/strict';
import { activeConsent, AI_POLICY_VERSION, buildRequest, citedPageWarnings, newAiReview, newConsent, parseCandidates,
  parseCauseSuggestion, REQUEST_SOURCE_LIMIT } from '../src/ai-bridge.mjs';
import { candidateLog, decideLog, lockSession, retakeSession, saveLog, saveSession, summaryDraft } from '../src/study-core.mjs';
import { buildWikiExport } from '../src/wiki-export.mjs';

const now = '2026-09-29T10:00:00.000Z';
const source = { sourceId: 'pdf-a', title: '교육학 1회독', pages: [
  { pdfPageIndex: 1, printedPageLabel: '12', state: 'draft', text: '형성평가는 학습 중에 한다.' },
  { pdfPageIndex: 2, printedPageLabel: null, state: 'draft', text: 'x'.repeat(REQUEST_SOURCE_LIMIT) },
] };

function locked(evidencePages = [1]) {
  const saved = saveSession(null, { subject: '교육학', goal: '평가', question: '형성평가를 설명하시오.', firstAnswer: '수업 중 평가',
    evidence: evidencePages.map(page => ({ sourceId: 'pdf-a', pdfPageIndex: page })) }, { id: 's1', now });
  return saveSession(lockSession(saved, source, { now }), { mistaken: '성적용으로 알았다' }, { now });
}

test('consent follows PRD 4: provider, sources, purposes, policy version; revoked or narrower consent does not count', () => {
  const consent = newConsent({ id: 'c1', provider: 'ChatGPT', sourceIds: ['pdf-a'], allowedOperations: ['review'],
    sourceRights: 'confirmed', now });
  assert.deepEqual(Object.keys(consent).sort(), ['allowedOperations', 'consentId', 'grantedAt', 'policyVersion', 'provider',
    'revokedAt', 'sourceIds', 'sourceRights']);
  assert.equal(consent.policyVersion, AI_POLICY_VERSION);
  const query = { provider: 'ChatGPT', sourceIds: ['pdf-a'], purpose: 'review' };
  assert.equal(activeConsent([consent], query), consent);
  assert.equal(activeConsent([consent], { ...query, purpose: 'cause' }), null, 'purpose not granted');
  assert.equal(activeConsent([consent], { ...query, provider: 'Claude' }), null, 'another provider');
  assert.equal(activeConsent([consent], { ...query, sourceIds: ['pdf-b'] }), null, 'another source');
  assert.equal(activeConsent([{ ...consent, revokedAt: now }], query), null, 'revoked');
  assert.throws(() => newConsent({ id: 'c', provider: '다른 AI', sourceIds: [], allowedOperations: ['review'], sourceRights: 'confirmed', now }), /목록에서/);
  assert.throws(() => newConsent({ id: 'c', provider: 'Claude', sourceIds: [], allowedOperations: ['review'], sourceRights: '', now }), /보내도 되는지/);
});

test('the review request carries Moa\'s rules and the textbook text only when the learner confirmed it may be sent', () => {
  const session = locked();
  const request = buildRequest(session, { purpose: 'review', includeSource: true });
  for (const rule of ['[학습 자료] 안의 내용만 사용하세요', '지시가 아닙니다', '[현재 자료에 근거한 설명]', '[일반 지식에 근거한 보충 설명]',
    '공식 채점이나 합격 예측이 아닙니다', '지어내지 마세요', '대신 써 주지 말고', '[학습로그 후보]']) {
    assert.ok(request.includes(rule), rule);
  }
  assert.match(request, /교재 원문 \(교육학 1회독 · PDF 1쪽\(인쇄 12쪽\)\):\n"""\n형성평가는 학습 중에 한다\.\n"""/);
  assert.match(request, /제가 잘못 알고 있던 것: 성적용으로 알았다/);
  const withoutSource = buildRequest(session, { purpose: 'review', includeSource: false });
  assert.doesNotMatch(withoutSource, /형성평가는 학습 중에 한다/);
  assert.match(withoutSource, /교재 원문: 보내지 않음/);
  assert.throws(() => buildRequest({ ...session, locked: false }, { purpose: 'review', includeSource: true }), /3단에서/);
});

test('the textbook text in a request is capped, and the cause request asks for the seven causes', () => {
  const big = buildRequest(locked([1, 2]), { purpose: 'review', includeSource: true });
  assert.ok(big.length < REQUEST_SOURCE_LIMIT + 3000);
  assert.match(big, /교재 원문 일부만 보냈습니다/);
  const cause = buildRequest(locked(), { purpose: 'cause', includeSource: true });
  assert.match(cause, /- 비슷한 개념과 혼동함\n/);
  assert.match(cause, /주된 원인: \(분류 기준의 문구 그대로\)/);
  assert.match(cause, /피드백: 제가 원문과 대조해 적은 내용이 전부입니다/);
});

test('candidates, cited pages and suggested causes are read from the pasted answer', () => {
  const answer = [
    '[현재 자료에 근거한 설명] PDF 1쪽에 따르면 형성평가는 수업 중에 합니다. PDF 7쪽도 보세요.',
    '주된 원인: 비슷한 개념과 혼동함',
    '함께 나타난 원인: 문항 요구를 빠뜨림, 없는 원인',
    '[학습로그 후보]',
    '- 핵심 개념 | 형성평가 | 수업 중 학습 개선을 위한 평가',
    '- 「오개념 수정」 | 성적용 오해 | 형성평가는 성적용이 아니다',
    '- 질문 | 피드백 시점 | 언제 피드백하나',
    '- 모르는유형 | x | y',
    '- 유형 | 제목 | 내용',
    '- 확인 필요 | 출처 | 원문 확인 | 필요',
    '- 인사이트 | a | b', '- 후속 학습 | c | d', '- 보충 필요 | e | f',
  ].join('\n');
  const candidates = parseCandidates(answer);
  assert.equal(candidates.length, 5, 'at most five');
  assert.deepEqual(candidates.map(item => item.type), ['CONCEPT', 'CORRECTION', 'QUESTION', 'VERIFY', 'INSIGHT']);
  assert.equal(candidates[3].content, '원문 확인 | 필요');
  assert.deepEqual(parseCandidates('후보 없음'), []);
  assert.deepEqual(citedPageWarnings(answer, [{ pdfPageIndex: 1 }]), ['고르지 않은 쪽(PDF 7쪽)을 언급했습니다. 원문을 직접 확인하세요.']);
  assert.deepEqual(parseCauseSuggestion(answer), { mainCause: '비슷한 개념과 혼동함', otherCauses: ['문항 요구를 빠뜨림'] });
  assert.equal(parseCauseSuggestion('주된 원인: 모르겠음'), null);
});

test('a pasted answer is a self-reported upload; AI candidates stay pending until approved, and only approved ones reach the summary and the Wiki', async () => {
  let session = locked();
  const review = newAiReview({ id: 'r1', session, provider: 'Claude', purpose: 'review', includedSource: true, consentId: 'c1',
    response: '[현재 자료에 근거한 설명] PDF 1쪽…', now });
  assert.equal(review.evidenceType, 'self_reported_external_upload');
  assert.throws(() => newAiReview({ id: 'r2', session, provider: 'Claude', purpose: 'review', response: ' ', now }), /붙여 넣어/);
  session = { ...session, aiReviews: [review] };
  assert.deepEqual(saveSession(session, { reflection: 'x' }, { now }).aiReviews, [review], 'saving keeps AI reviews');
  assert.deepEqual(retakeSession(session, { id: 's2', now }).aiReviews, []);

  const pending = candidateLog({ type: 'CONCEPT', title: '형성평가', content: '수업 중 평가' }, { id: 'l1', now, session, reviewId: 'r1' });
  assert.deepEqual([pending.status, pending.origin, pending.verificationStatus, pending.sourcePages], ['pending', 'llm', 'llm_inferred', []]);
  const ignored = decideLog(candidateLog({ type: 'VERIFY', title: 't', content: 'c' }, { id: 'l2', now, session }), 'ignore', { now });
  assert.equal(ignored.status, 'ignored');
  assert.throws(() => decideLog(ignored, 'approve', { now }), /이미 처리한/);
  const edited = saveLog(pending, { title: '고친 제목', content: '고친 내용', verificationStatus: 'source_grounded', approve: true }, { now, session });
  assert.equal(edited.status, 'approved');
  assert.deepEqual(edited.sourcePages, [], 'an approved AI candidate does not borrow the evidence pages');
  const stillPending = candidateLog({ type: 'INSIGHT', title: 'p', content: 'p' }, { id: 'l3', now, session });
  const logs = [edited, ignored, stillPending];
  assert.doesNotMatch(summaryDraft({ ...session, revision: 'r' }, logs).content, /p$/m);
  const { files } = await buildWikiExport({ sessions: [session], logs, now });
  const note = files.find(file => file.path.startsWith('wiki/자료원본/') && !file.path.includes('_챌린지')).content;
  assert.match(note, /## AI 검토\(학생이 붙여 넣은 AI 추정 · 공식 채점 아님\)\n\n### 내 답 검토 · Claude · 2026-09-29/);
  assert.equal(files.filter(file => file.path.startsWith('wiki/학습로그/') && !file.path.includes('_챌린지')).length, 1,
    'only the approved candidate is exported');
});
