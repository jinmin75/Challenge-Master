// 학습실 (D023 A-2): Moa's four steps without AI — question and first answer → evidence pages → compare with the
// original → revised answer and review date. Checked against docs/moa-lessons.md:
// #1 every disabled button shows why, next to it; #2 every action redraws the whole view from stored records.
import { lockBlocker, MAX_EVIDENCE, saveBlocker, searchPages, sessionStatus, sessionTitle } from './src/study-core.mjs';

const STEPS = [
  { n: 1, name: '문제와 첫 답안' },
  { n: 2, name: '근거 고르기' },
  { n: 3, name: '원문과 대조' },
  { n: 4, name: '수정 답안과 복습' },
];
const FIELDS = ['subject', 'goal', 'studiedSection', 'question', 'firstAnswer', 'missing', 'mistaken', 'unverified',
  'revision', 'reflection', 'reviewDate'];

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'value') node.value = value;
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value);
  }
  node.append(...children.filter(child => child !== null && child !== undefined && child !== false));
  return node;
}

function emptySession() {
  return { id: null, subject: '', goal: '', studiedSection: '', question: '', firstAnswer: '', evidence: [], locked: false,
    missing: '', mistaken: '', unverified: '', revision: '', reflection: '', reviewDate: '', parentId: null };
}

function pageLabel(page) {
  return page.printedPageLabel ? `PDF ${page.pdfPageIndex}쪽 (인쇄 쪽 ${page.printedPageLabel})` : `PDF ${page.pdfPageIndex}쪽`;
}

function shortDate(iso) {
  const date = new Date(iso);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

export function createStudyView({ api }) {
  const root = document.querySelector('#view-study');
  const listNode = root.querySelector('#studyList');
  const newButton = root.querySelector('#studyNew');
  const workNode = root.querySelector('#studyWork');
  let sessions = [];
  let source = null;
  let current = emptySession();
  let openStep = 1;
  let dirty = false;
  let evidenceQuery = '';
  let evidenceFocus = null;
  let shownEvidence = 0;
  const notes = {};

  function field(name) {
    return workNode.querySelector(`[data-field="${name}"]`);
  }

  // The current form values; locked fields keep their stored values.
  function draft() {
    const values = { id: current.id, parentId: current.parentId, evidence: current.evidence };
    for (const name of FIELDS) {
      const node = field(name);
      values[name] = node ? node.value : current[name];
    }
    return values;
  }

  function note(step, message, kind = 'info') {
    notes[step] = { message, kind };
  }

  async function act(step, button, action) {
    if (button.disabled) return;
    button.disabled = true;
    try {
      await action();
    } catch (error) {
      note(step, error.message, 'error');
    }
    await reload();
  }

  function confirmLeave() {
    return !dirty || window.confirm('저장하지 않은 내용이 있습니다. 저장하지 않고 옮길까요?');
  }

  function select(session, step = 1) {
    current = session ? structuredClone(session) : emptySession();
    openStep = step;
    dirty = false;
    shownEvidence = 0;
    evidenceFocus = null;
    for (const key of Object.keys(notes)) delete notes[key];
    render();
  }

  // ---- step bodies ----

  function textInput(name, label, { multiline = false, rows = 4, readOnly = false, type = 'text' } = {}) {
    const control = multiline
      ? el('textarea', { 'data-field': name, rows: String(rows), readonly: readOnly })
      : el('input', { 'data-field': name, type, readonly: readOnly });
    control.value = current[name] ?? '';
    control.addEventListener('input', () => {
      dirty = true;
      refreshBlockers();
    });
    return el('label', {}, label, control);
  }

  function stepNote(step) {
    const item = notes[step];
    return el('p', { class: `step-note ${item?.kind ?? ''}`, role: item?.kind === 'error' ? 'alert' : 'status',
      'data-note': String(step), text: item?.message ?? '' });
  }

  // A button plus the sentence that says why it is disabled (moa-lessons #1).
  function guardedButton({ label, blocker, onClick, kind = '', step }) {
    const button = el('button', { type: 'button', class: kind, 'data-action': label });
    button.textContent = label;
    const reason = el('span', { class: 'blocked-reason', 'data-reason': label });
    const apply = value => {
      button.disabled = Boolean(value);
      reason.textContent = value ? `잠김: ${value}` : '';
    };
    apply(blocker());
    button.addEventListener('click', () => act(step, button, onClick));
    guards.push(() => apply(blocker()));
    return el('div', { class: 'guarded' }, button, reason);
  }
  let guards = [];

  function refreshBlockers() {
    for (const refresh of guards) refresh();
  }

  function step1() {
    const locked = current.locked;
    return [
      el('div', { class: 'study-grid' },
        textInput('subject', '과목·영역'),
        textInput('studiedSection', '현재 학습 위치(단원·쪽)')),
      textInput('goal', '공부 목표'),
      textInput('question', '문제', { multiline: true, rows: 4, readOnly: locked }),
      textInput('firstAnswer', '첫 답안 (원문을 보기 전에 내 답을 먼저 씁니다)', { multiline: true, rows: 7, readOnly: locked }),
      locked ? el('p', { class: 'muted', text: '대조를 시작해 문제와 첫 답안이 고정되었습니다. 다른 답으로 다시 하려면 4단의 「다시 풀기」를 누르세요.' }) : null,
      guardedButton({ label: '기록 저장', step: 1, blocker: () => saveBlocker(draft()), onClick: async () => {
        const saved = await api.saveStudySession(draft());
        current = saved;
        dirty = false;
        openStep = locked ? 1 : 2;
        note(openStep, '저장했습니다.');
      } }),
      stepNote(1),
    ];
  }

  function evidenceChoices() {
    if (!source) {
      return [el('p', { class: 'muted' }, '대조할 교재가 없습니다. ', el('a', { href: '#plan', text: '「오늘 계획」 탭' }),
        '에서 PDF를 먼저 등록하세요.')];
    }
    const chosen = new Set(current.evidence.filter(ref => ref.sourceId === source.sourceId).map(ref => ref.pdfPageIndex));
    const hits = evidenceQuery.trim() ? new Map(searchPages(source.pages, evidenceQuery).map(hit => [hit.pdfPageIndex, hit.count])) : null;
    const search = el('input', { type: 'search', 'aria-label': '근거 쪽 찾기', value: evidenceQuery });
    search.addEventListener('input', () => {
      evidenceQuery = search.value;
      rerender();
      workNode.querySelector('[aria-label="근거 쪽 찾기"]')?.focus();
    });
    const pages = source.pages.filter(page => !hits || hits.has(page.pdfPageIndex));
    const list = el('ul', { class: 'evidence-list' }, ...pages.map(page => {
      const selectable = page.state === 'draft';
      const full = !chosen.has(page.pdfPageIndex) && chosen.size >= MAX_EVIDENCE;
      const box = el('input', { type: 'checkbox', disabled: !selectable || full || !current.id });
      box.checked = chosen.has(page.pdfPageIndex);
      box.addEventListener('change', async () => {
        const next = box.checked
          ? [...current.evidence, { sourceId: source.sourceId, pdfPageIndex: page.pdfPageIndex }]
          : current.evidence.filter(ref => !(ref.sourceId === source.sourceId && ref.pdfPageIndex === page.pdfPageIndex));
        try {
          current = await api.saveStudySession({ ...draft(), evidence: next });
          dirty = false;
          note(2, `고른 쪽 ${current.evidence.length}개를 저장했습니다.`);
        } catch (error) {
          note(2, error.message, 'error');
        }
        await reload();
      });
      const why = !current.id ? '1단에서 기록을 먼저 저장하세요.'
        : !selectable ? '글자가 없는 쪽이라 고를 수 없습니다.'
          : full ? `근거는 ${MAX_EVIDENCE}개까지 고를 수 있습니다.` : '';
      const preview = el('button', { type: 'button', class: 'link-button', text: '미리 보기' });
      preview.addEventListener('click', () => {
        evidenceFocus = evidenceFocus === page.pdfPageIndex ? null : page.pdfPageIndex;
        rerender();
      });
      return el('li', {},
        el('label', { class: 'evidence-choice' }, box, ` ${pageLabel(page)}`,
          hits ? el('span', { class: 'page-hits', text: `찾은 곳 ${hits.get(page.pdfPageIndex)}` }) : null),
        selectable ? preview : null,
        why ? el('span', { class: 'blocked-reason', text: why }) : null,
        evidenceFocus === page.pdfPageIndex ? el('pre', { class: 'page-text evidence-preview', text: page.text }) : null);
    }));
    return [
      el('label', {}, '교재에서 찾기', search),
      el('p', { class: 'muted', text: `${source.title} · 고른 쪽 ${chosen.size}/${MAX_EVIDENCE}` }),
      list,
    ];
  }

  function step2() {
    if (current.locked) {
      return [
        el('p', { class: 'muted', text: '대조를 시작해 근거가 고정되었습니다. 대조할 때의 글자가 이 기록 안에 저장되어 있습니다.' }),
        el('ul', {}, ...current.evidence.map(ref => el('li', { text: `${ref.sourceTitle} · ${pageLabel(ref)}${ref.truncated ? ' · 일부만 저장' : ''}` }))),
      ];
    }
    return [
      ...evidenceChoices(),
      el('p', { class: 'muted', text: '「원문과 대조 시작」을 누르면 문제·첫 답안·고른 근거가 고정됩니다. 다른 조건으로 하려면 나중에 「다시 풀기」를 씁니다.' }),
      guardedButton({ label: '원문과 대조 시작', step: 2,
        blocker: () => (dirty ? '1단에서 바꾼 내용을 먼저 저장하세요.' : lockBlocker(current.id ? current : null)),
        onClick: async () => {
          if (!window.confirm('대조를 시작하면 문제, 첫 답안, 고른 근거를 더 바꿀 수 없습니다. 시작할까요?')) return;
          current = await api.lockStudySession(current.id);
          openStep = 3;
          note(3, '대조를 시작했습니다. 첫 답안과 원문을 비교해 빠진 것과 틀린 것을 적으세요.');
        } }),
      stepNote(2),
    ];
  }

  function step3() {
    if (!current.locked) {
      return [el('p', { class: 'blocked-reason', text: `잠김: ${lockBlocker(current.id ? current : null) ?? '2단에서 「원문과 대조 시작」을 누르면 열립니다.'}` })];
    }
    const evidence = current.evidence[Math.min(shownEvidence, current.evidence.length - 1)];
    const tabs = el('div', { class: 'evidence-tabs', role: 'tablist' }, ...current.evidence.map((ref, index) => {
      const tab = el('button', { type: 'button', role: 'tab', 'aria-selected': index === shownEvidence ? 'true' : 'false',
        text: `${ref.pdfPageIndex}쪽` });
      tab.addEventListener('click', () => {
        shownEvidence = index;
        rerender();
      });
      return tab;
    }));
    return [
      el('div', { class: 'compare' },
        el('section', {}, el('h4', { text: '내 첫 답안(고정)' }), el('pre', { class: 'page-text', text: current.firstAnswer })),
        el('section', {}, el('h4', { text: `원문 · ${pageLabel(evidence)}` }), tabs,
          el('pre', { class: 'page-text', text: evidence.text }),
          evidence.truncated ? el('p', { class: 'muted', text: '이 쪽은 앞부분만 저장했습니다. 나머지는 원본 PDF에서 확인하세요.' }) : null)),
      textInput('missing', '처음 답에서 빠진 것', { multiline: true, rows: 3 }),
      textInput('mistaken', '잘못 알고 있던 것', { multiline: true, rows: 3 }),
      textInput('unverified', '아직 확인하지 못한 것(원문으로도 판단이 안 되는 것)', { multiline: true, rows: 2 }),
      guardedButton({ label: '대조 내용 저장', step: 3, blocker: () => null, onClick: async () => {
        current = await api.saveStudySession(draft());
        dirty = false;
        note(3, '저장했습니다. 4단에서 답을 고쳐 쓰세요.');
      } }),
      stepNote(3),
    ];
  }

  function step4() {
    if (!current.locked) {
      return [el('p', { class: 'blocked-reason', text: '잠김: 3단에서 원문과 대조한 뒤에 고쳐 씁니다.' })];
    }
    const clearDate = el('button', { type: 'button', class: 'link-button', text: '복습일 지우기' });
    clearDate.addEventListener('click', () => {
      field('reviewDate').value = '';
      dirty = true;
    });
    return [
      textInput('revision', '수정 답안', { multiline: true, rows: 7 }),
      textInput('reflection', '복습 메모(다음에 먼저 볼 것)', { multiline: true, rows: 3 }),
      el('div', { class: 'review-date' }, textInput('reviewDate', '복습일(직접 고릅니다)', { type: 'date' }), clearDate),
      el('div', { class: 'actions' },
        guardedButton({ label: '저장', step: 4, blocker: () => null, onClick: async () => {
          current = await api.saveStudySession(draft());
          dirty = false;
          note(4, '저장했습니다.');
        } }),
        guardedButton({ label: '다시 풀기', kind: 'secondary', step: 4,
          blocker: () => (dirty ? '바꾼 내용을 먼저 저장하세요.' : null),
          onClick: async () => {
            const retake = await api.retakeStudySession(current.id);
            select(retake, 1);
            note(1, '같은 문제로 새 기록을 만들었습니다. 첫 답안부터 다시 쓰세요.');
          } })),
      stepNote(4),
    ];
  }

  // ---- layout ----

  function stepState(n) {
    if (n === 1) return current.id ? (current.locked ? '고정됨' : '저장됨') : '작성 중';
    if (n === 2) return current.locked ? `고정됨 · ${current.evidence.length}쪽` : `${current.evidence.length}쪽 고름`;
    if (n === 3) return current.locked ? (current.missing || current.mistaken ? '적음' : '열림') : '잠김';
    return current.locked ? (current.revision ? '고쳐 씀' : '열림') : '잠김';
  }

  function renderList() {
    listNode.replaceChildren(...(sessions.length === 0
      ? [el('li', { class: 'muted', text: '아직 학습 기록이 없습니다. 「새 기록」으로 시작하세요.' })]
      : sessions.map(session => {
        const button = el('button', { type: 'button', class: 'session-item', 'aria-current': session.id === current.id ? 'true' : 'false' },
          el('span', { class: 'session-title', text: sessionTitle(session) }),
          el('span', { class: 'session-meta', text: `${sessionStatus(session)} · ${shortDate(session.updatedAt)}${session.reviewDate ? ` · 복습일 ${session.reviewDate}` : ''}` }));
        button.addEventListener('click', () => {
          if (session.id === current.id || !confirmLeave()) return;
          select(session, session.locked ? 3 : 1);
        });
        return el('li', {}, button);
      })));
  }

  function renderWork() {
    guards = [];
    const bodies = { 1: step1, 2: step2, 3: step3, 4: step4 };
    const header = el('div', { class: 'study-head' },
      el('h3', { text: current.id ? sessionTitle(current) : '새 기록' }),
      current.id ? el('p', { class: 'muted', text: `${sessionStatus(current)}${current.parentId ? ' · 다시 풀기 기록' : ''}` }) : null);
    const steps = STEPS.map(step => {
      const open = openStep === step.n;
      const toggle = el('button', { type: 'button', class: 'step-toggle', 'aria-expanded': open ? 'true' : 'false' },
        el('span', { class: 'step-no', text: String(step.n) }), `${step.name} `,
        el('span', { class: 'step-state', text: stepState(step.n) }));
      toggle.addEventListener('click', () => {
        openStep = open ? 0 : step.n;
        rerender();
      });
      return el('section', { class: `study-step${open ? ' open' : ''}`, 'data-step': String(step.n) },
        toggle, open ? el('div', { class: 'step-body' }, ...bodies[step.n]()) : null);
    });
    const actions = current.id ? (() => {
      const remove = el('button', { type: 'button', class: 'link-button danger-link', text: '이 기록 지우기' });
      remove.addEventListener('click', () => {
        if (!window.confirm('이 학습 기록을 지웁니다. 백업 파일이 없으면 되돌릴 수 없습니다. 지울까요?')) return;
        act(openStep || 1, remove, async () => {
          await api.deleteStudySession(current.id);
          // Draw once, after the list reloads (act → reload), so the deleted record never shows as current.
          current = emptySession();
          openStep = 1;
          dirty = false;
          for (const key of Object.keys(notes)) delete notes[key];
        });
      });
      return el('p', { class: 'study-foot' }, remove);
    })() : null;
    workNode.replaceChildren(header, ...steps, actions);
  }

  function render() {
    renderList();
    renderWork();
  }

  // Redraw after opening a step, searching or switching evidence within the same record: typed but unsaved
  // values are taken from the form first so they survive the redraw.
  function rerender() {
    Object.assign(current, pick(draft()));
    render();
  }

  // Reloads records and redraws everything (moa-lessons #2); keeps unsaved form values.
  async function reload() {
    const keep = dirty ? draft() : null;
    [sessions, source] = await Promise.all([api.studySessions(), api.sourceView()]);
    if (current.id) {
      const stored = sessions.find(item => item.id === current.id);
      current = stored ? { ...structuredClone(stored), ...(keep ? pick(keep) : {}) } : emptySession();
    }
    render();
  }

  function pick(values) {
    const editable = current.locked ? FIELDS.filter(name => !['question', 'firstAnswer'].includes(name)) : FIELDS;
    return Object.fromEntries(editable.map(name => [name, values[name]]));
  }

  newButton.addEventListener('click', () => {
    if (!confirmLeave()) return;
    select(null);
  });

  return {
    update: reload,
  };
}
