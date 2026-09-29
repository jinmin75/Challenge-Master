// Study features of the web version (D023): pure helpers shared by the page and the unit tests.
// No Node or browser APIs. Step A-1 turns the stored PDF extraction into readable pages and finds words in them.
import { creditedTaskMinutes, originalTaskMinutes } from './events.mjs';

// The draft keeps each page as a fenced ```text block (pdf-core.mjs); the reader shows the text inside.
export function unfence(markdown = '') {
  const match = /^(`{3,})text\n([\s\S]*)\n\1$/.exec(markdown);
  return match ? match[2] : markdown;
}

// The registered source as pages to read. Returns null before a PDF is registered (demo input).
export function sourcePages({ setup, draft } = {}) {
  if (!setup?.source || !draft?.manifest?.pages) return null;
  const pages = (setup.source.selectedPages ?? []).map(number => {
    const page = draft.manifest.pages[String(number)] ?? null;
    const text = page ? unfence(page.markdown) : '';
    const label = page && page.printedPageLabel && page.printedPageLabel !== 'unknown' ? page.printedPageLabel : null;
    let state = 'draft';
    if (!page) state = 'missing';
    else if (page.status === 'failed') state = 'failed';
    else if (!text) state = 'textless';
    return {
      pdfPageIndex: number,
      printedPageLabel: label,
      state,
      text,
      issues: page?.validation?.issues ?? [],
    };
  });
  return {
    title: setup.title,
    originalName: setup.source.originalName,
    sourceId: draft.sourceId ?? null,
    pages,
  };
}

function normalize(value) {
  return String(value ?? '').toLocaleLowerCase('ko-KR');
}

// Start/end offsets of every match of `query` in `text` (case-insensitive for Latin letters, as typed for Korean).
export function matchRanges(text, query) {
  const needle = normalize(query).trim();
  if (!needle) return [];
  const haystack = normalize(text);
  const ranges = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    ranges.push([at, at + needle.length]);
  }
  return ranges;
}

// Pages that contain the query, with how many times it appears on each.
export function searchPages(pages, query) {
  return pages
    .map(page => ({ pdfPageIndex: page.pdfPageIndex, count: matchRanges(page.text, query).length }))
    .filter(result => result.count > 0);
}

// ---- A-2 학습실: study sessions (Moa's 4 steps without AI; D023, docs/moa-lessons.md) ----

export const MAX_SESSIONS = 2000;
export const MAX_EVIDENCE = 8;
const LIMITS = { subject: 120, goal: 500, studiedSection: 120, question: 20000, firstAnswer: 20000, missing: 4000,
  mistaken: 4000, unverified: 4000, revision: 20000, reflection: 4000, nextAction: 500 };
// Text kept from each evidence page when the session locks, so later registrations cannot change it.
export const EVIDENCE_TEXT_LIMIT = 20000;

function text(value, field) {
  const result = String(value ?? '');
  if (result.length > LIMITS[field]) throw new Error(`${FIELD_NAMES[field]}이(가) 너무 깁니다(${LIMITS[field].toLocaleString('ko-KR')}자까지).`);
  return result;
}

const FIELD_NAMES = { subject: '과목', goal: '공부 목표', studiedSection: '학습 위치', question: '문제', firstAnswer: '첫 답안',
  missing: '빠진 것', mistaken: '잘못 알고 있던 것', unverified: '아직 확인하지 못한 것', revision: '수정 답안', reflection: '복습 메모',
  nextAction: '다음 연습' };

export function sessionTitle(session) {
  const subject = session.subject.trim();
  const goal = session.goal.trim();
  if (subject && goal) return `${subject} · ${goal}`.slice(0, 120);
  const question = session.question.trim().replace(/\s+/g, ' ');
  if (question) return question.slice(0, 80);
  return subject || '임용 답안 연습';
}

// Status label for the list, as in Moa: locked → 대조 시작; revised → 수정 중; answered → 초안 저장.
export function sessionStatus(session) {
  if (session.locked && (session.revision.trim() || session.reflection.trim())) return '수정 중';
  if (session.locked) return '대조 시작';
  if (session.firstAnswer.trim()) return '초안 저장';
  return '작성 중';
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime());
}

// Why the session cannot be saved yet (null when it can). Moa's rule: a question and a first answer.
export function saveBlocker(draft) {
  if (!String(draft.question ?? '').trim()) return '문제를 먼저 입력하세요.';
  if (!String(draft.firstAnswer ?? '').trim()) return '첫 답안을 먼저 작성하세요. 원문을 보기 전에 내 답을 먼저 씁니다.';
  return null;
}

// Why comparison (step 3) cannot start yet (null when it can).
export function lockBlocker(session) {
  if (!session) return '먼저 1단에서 기록을 저장하세요.';
  const blocker = saveBlocker(session);
  if (blocker) return blocker;
  if ((session.evidence ?? []).length === 0) return '2단에서 대조할 교재 쪽을 1개 이상 고르세요.';
  return null;
}

// Creates or updates a session. After locking, the question, first answer and evidence keep their locked values.
export function saveSession(previous, input, { id, now }) {
  // Judge the values that would be stored: fields left out of the input keep their saved values.
  const blocker = saveBlocker(previous?.locked ? previous : {
    question: input.question ?? previous?.question, firstAnswer: input.firstAnswer ?? previous?.firstAnswer });
  if (blocker) throw new Error(blocker);
  const locked = previous?.locked === true;
  const evidence = locked ? previous.evidence : normalizeEvidenceRefs(input.evidence ?? previous?.evidence ?? []);
  const reviewDate = String(input.reviewDate ?? previous?.reviewDate ?? '');
  if (reviewDate && !isDate(reviewDate)) throw new Error('복습일은 날짜로 골라 주세요.');
  const field = name => text(input[name] ?? previous?.[name] ?? '', name);
  return {
    id: previous?.id ?? id,
    parentId: previous?.parentId ?? (input.parentId || null),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    subject: field('subject'),
    goal: field('goal'),
    studiedSection: field('studiedSection'),
    question: locked ? previous.question : field('question'),
    firstAnswer: locked ? previous.firstAnswer : field('firstAnswer'),
    evidence,
    locked,
    lockedAt: previous?.lockedAt ?? null,
    missing: field('missing'),
    mistaken: field('mistaken'),
    unverified: field('unverified'),
    revision: field('revision'),
    reflection: field('reflection'),
    reviewDate,
    ...causes(input, previous),
    nextAction: field('nextAction'),
    reviewMinutes: reviewMinutes(input.reviewMinutes ?? previous?.reviewMinutes ?? REVIEW_MINUTES_DEFAULT),
    reviews: previous?.reviews ?? [],
  };
}

function causes(input, previous) {
  const mainCause = String(input.mainCause ?? previous?.mainCause ?? '');
  if (mainCause && !CAUSES.includes(mainCause)) throw new Error('오답 원인을 목록에서 고르세요.');
  const other = input.otherCauses ?? previous?.otherCauses ?? [];
  if (!Array.isArray(other) || other.some(cause => !CAUSES.includes(cause))) throw new Error('함께 나타난 원인을 목록에서 고르세요.');
  return { mainCause, otherCauses: [...new Set(other)].filter(cause => cause !== mainCause) };
}

function reviewMinutes(value) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 120) throw new Error('복습에 쓸 시간은 5~120분 사이의 정수로 적어 주세요.');
  return minutes;
}

function normalizeEvidenceRefs(refs) {
  if (!Array.isArray(refs)) throw new Error('근거 목록이 올바르지 않습니다.');
  if (refs.length > MAX_EVIDENCE) throw new Error(`근거는 ${MAX_EVIDENCE}개까지 고를 수 있습니다.`);
  const seen = new Set();
  return refs.map(ref => {
    if (!Number.isInteger(ref?.pdfPageIndex) || ref.pdfPageIndex < 1) throw new Error('근거 쪽 번호가 올바르지 않습니다.');
    const key = `${ref.sourceId}#${ref.pdfPageIndex}`;
    if (seen.has(key)) throw new Error('같은 쪽을 두 번 고를 수 없습니다.');
    seen.add(key);
    return { sourceId: ref.sourceId ?? null, pdfPageIndex: ref.pdfPageIndex };
  });
}

// Step 3 starts: freeze question, first answer and evidence, copying each evidence page's text into the session.
export function lockSession(session, source, { now }) {
  const blocker = lockBlocker(session);
  if (blocker) throw new Error(blocker);
  if (session.locked) return session;
  const evidence = session.evidence.map(ref => {
    const page = source?.sourceId === ref.sourceId
      ? source.pages.find(item => item.pdfPageIndex === ref.pdfPageIndex) : null;
    if (!page || page.state !== 'draft') {
      throw new Error(`고른 근거(PDF ${ref.pdfPageIndex}쪽)를 지금 교재에서 찾을 수 없습니다. 2단에서 근거를 다시 고르세요.`);
    }
    return {
      sourceId: ref.sourceId,
      pdfPageIndex: ref.pdfPageIndex,
      printedPageLabel: page.printedPageLabel,
      sourceTitle: source.title,
      text: page.text.slice(0, EVIDENCE_TEXT_LIMIT),
      truncated: page.text.length > EVIDENCE_TEXT_LIMIT,
    };
  });
  return { ...session, evidence, locked: true, lockedAt: now, updatedAt: now };
}

// 다시 풀기: a new unlocked session on the same question and evidence pages; answers start empty.
export function retakeSession(session, { id, now }) {
  return {
    id,
    parentId: session.id,
    createdAt: now,
    updatedAt: now,
    subject: session.subject,
    goal: session.goal,
    studiedSection: session.studiedSection,
    question: session.question,
    firstAnswer: '',
    evidence: session.evidence.map(ref => ({ sourceId: ref.sourceId, pdfPageIndex: ref.pdfPageIndex })),
    locked: false,
    lockedAt: null,
    missing: '', mistaken: '', unverified: '', revision: '', reflection: '', reviewDate: '',
    mainCause: '', otherCauses: [], nextAction: '', reviewMinutes: session.reviewMinutes ?? REVIEW_MINUTES_DEFAULT, reviews: [],
  };
}

// ---- A-3 오답노트와 복습 배정 ----

// The seven causes from the exam vault prompt 「오답 원인 분류하기」 (04_오답과_주간복습.md).
export const CAUSES = ['개념을 기억하지 못함', '비슷한 개념과 혼동함', '문항 요구를 빠뜨림', '근거 없이 추정함',
  '알고 있었지만 답안으로 조직하지 못함', '시간 배분 또는 검토 실패', '현재 자료만으로 분류할 수 없음'];
export const REVIEW_MINUTES_DEFAULT = 10;
const NOTE_TASK_PREFIX = 'note:';

// A session belongs to the 오답노트 once the learner names its main cause.
export function isNote(session) {
  return Boolean(session?.mainCause);
}

// One plan task per session and review date, so each review cycle is counted on its own.
export function reviewTaskId(sessionId, date) {
  return `${NOTE_TASK_PREFIX}${sessionId}:${date}`;
}

function planItems(state) {
  return (state?.plans ?? []).flatMap(plan => [...plan.allocations, ...plan.deferred]);
}

// Where the current review of a note stands. The plan is the record of time spent: a planned review is done when
// its minutes are fully credited; a review that never entered a plan is done when the learner marks it directly.
export function reviewCycle(session, state, today) {
  const date = session.reviewDate;
  if (!date) return null;
  const taskId = reviewTaskId(session.id, date);
  const planned = planItems(state).some(item => item.taskId === taskId);
  const minutes = planned ? originalTaskMinutes(state, taskId) : session.reviewMinutes ?? REVIEW_MINUTES_DEFAULT;
  const credited = planned ? creditedTaskMinutes(state, taskId) : 0;
  const markedDone = (session.reviews ?? []).some(review => review.dueDate === date);
  const current = state?.currentPlan?.allocations.find(item => item.taskId === taskId) ?? null;
  return {
    date,
    taskId,
    due: date <= today,
    planned,
    inCurrentPlan: Boolean(current),
    minutes,
    credited,
    done: markedDone || (planned && credited >= minutes),
  };
}

// Plan tasks for 오답 reviews: every review task that already entered a plan keeps its first estimate (replanning
// requires every prior task), and each note whose review date has come and is not done adds one task.
export function reviewTasks({ sessions, state, today }) {
  const tasks = new Map();
  for (const item of planItems(state)) {
    if (!item.taskId.startsWith(NOTE_TASK_PREFIX) || tasks.has(item.taskId)) continue;
    tasks.set(item.taskId, { id: item.taskId, title: item.title ?? '오답 복습', kind: 'review',
      minutes: originalTaskMinutes(state, item.taskId), splittable: true, dueDate: item.taskId.slice(-10) });
  }
  for (const session of sessions ?? []) {
    if (!isNote(session)) continue;
    const cycle = reviewCycle(session, state, today);
    if (!cycle || !cycle.due || cycle.done || tasks.has(cycle.taskId)) continue;
    tasks.set(cycle.taskId, { id: cycle.taskId, title: `오답 복습: ${sessionTitle(session)}`.slice(0, 120), kind: 'review',
      minutes: cycle.minutes, splittable: true, dueDate: cycle.date });
  }
  return [...tasks.values()];
}

// Why the review date cannot change now (null when it can): a review already in a plan must be finished first,
// or the plan would keep a task the learner meant to move.
export function reviewDateBlocker(session, state, today) {
  const cycle = session ? reviewCycle(session, state, today) : null;
  if (!cycle || !cycle.planned || cycle.done) return null;
  return `${cycle.date} 복습이 계획에 들어가 있습니다. 「오답노트」에서 복습을 마친 뒤 다음 복습일을 고르세요.`;
}

// Notes for the 오답노트 tab: reviews due now first, then by review date, then most recently edited.
export function noteItems({ sessions, state, today }) {
  return (sessions ?? []).filter(isNote).map(session => {
    const cycle = reviewCycle(session, state, today);
    const overdueDays = cycle && cycle.due && !cycle.done
      ? Math.round((new Date(`${today}T00:00:00`) - new Date(`${cycle.date}T00:00:00`)) / 86400000) : 0;
    return { session, title: sessionTitle(session), mainCause: session.mainCause, otherCauses: session.otherCauses ?? [],
      cycle, overdueDays, dueNow: Boolean(cycle && cycle.due && !cycle.done) };
  }).sort((a, b) => (Number(b.dueNow) - Number(a.dueNow))
    || (a.cycle?.date ?? '9999-12-31').localeCompare(b.cycle?.date ?? '9999-12-31')
    || b.session.updatedAt.localeCompare(a.session.updatedAt));
}

// Why 「복습했어요」 cannot be used now (null when it can).
export function completeBlocker(cycle) {
  if (!cycle) return '복습일이 없습니다. 학습실 4단에서 복습일을 고르세요.';
  if (!cycle.due) return `${cycle.date}에 복습할 차례가 됩니다.`;
  if (cycle.done) return '이 복습은 마쳤습니다. 다음 복습일을 고르세요.';
  if (cycle.planned && !cycle.inCurrentPlan) {
    return '지난 계획에 들어 있던 복습입니다. 「오늘 계획」에서 「남은 과업 다시 배정」을 누른 뒤 기록하세요.';
  }
  return null;
}
