// Study features of the web version (D023): pure helpers shared by the page and the unit tests.
// No Node or browser APIs. Step A-1 turns the stored PDF extraction into readable pages and finds words in them.

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
  mistaken: 4000, unverified: 4000, revision: 20000, reflection: 4000 };
// Text kept from each evidence page when the session locks, so later registrations cannot change it.
export const EVIDENCE_TEXT_LIMIT = 20000;

function text(value, field) {
  const result = String(value ?? '');
  if (result.length > LIMITS[field]) throw new Error(`${FIELD_NAMES[field]}이(가) 너무 깁니다(${LIMITS[field].toLocaleString('ko-KR')}자까지).`);
  return result;
}

const FIELD_NAMES = { subject: '과목', goal: '공부 목표', studiedSection: '학습 위치', question: '문제', firstAnswer: '첫 답안',
  missing: '빠진 것', mistaken: '잘못 알고 있던 것', unverified: '아직 확인하지 못한 것', revision: '수정 답안', reflection: '복습 메모' };

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
  const blocker = saveBlocker(previous?.locked ? previous : input);
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
  };
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
  };
}
