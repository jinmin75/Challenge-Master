// 학습실 (D023 A-2): Moa's four steps without AI — question and first answer → evidence pages → compare with the
// original → revised answer and review date. Checked against docs/moa-lessons.md:
// #1 every disabled button shows why, next to it; #2 every action redraws the whole view from stored records.
import { CAUSES, defaultVerification, LOG_TYPES, lockBlocker, logBlocker, logPrefill, MANUAL_LOG_TYPES, MAX_EVIDENCE,
  REVIEW_MINUTES_DEFAULT, saveBlocker, searchPages, sessionStatus, staleEvidence, sessionTitle, summaryBlocker, summaryDraft,
  VERIFICATION } from './src/study-core.mjs';
import { parseCauseSuggestion, PROVIDERS, PURPOSES, REQUEST_SOURCE_LIMIT, RESPONSE_LIMIT } from './src/ai-bridge.mjs';

const STEPS = [
  { n: 1, name: '문제와 첫 답안' },
  { n: 2, name: '근거 고르기' },
  { n: 3, name: '원문과 대조' },
  { n: 4, name: '수정 답안과 복습' },
];
const FIELDS = ['subject', 'goal', 'studiedSection', 'question', 'firstAnswer', 'missing', 'mistaken', 'unverified',
  'revision', 'reflection', 'reviewDate', 'mainCause', 'nextAction', 'reviewMinutes'];

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
    missing: '', mistaken: '', unverified: '', revision: '', reflection: '', reviewDate: '', parentId: null,
    mainCause: '', otherCauses: [], nextAction: '', reviewMinutes: REVIEW_MINUTES_DEFAULT };
}

function pageLabel(page) {
  return page.printedPageLabel ? `PDF ${page.pdfPageIndex}쪽 (인쇄 쪽 ${page.printedPageLabel})` : `PDF ${page.pdfPageIndex}쪽`;
}

function shortDate(iso) {
  const date = new Date(iso);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

export function createStudyView({ api, onChange = async () => {} }) {
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
  let review = { cycle: null, dateBlocker: null };
  let pendingOpen = null;
  let logs = [];
  let logForm = null;
  let summaryForm = null;
  // B: the learner's own AI. provider and purpose stay chosen across records; the rest belongs to one record.
  const ai = { provider: PROVIDERS[0], purpose: 'review', info: null, rights: '', agreed: false, response: '' };
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
    values.reviewMinutes = Number(values.reviewMinutes);
    const boxes = workNode.querySelectorAll('[data-other-cause]');
    values.otherCauses = boxes.length > 0
      ? [...boxes].filter(box => box.checked).map(box => box.value) : current.otherCauses ?? [];
    return values;
  }

  function note(step, message, kind = 'info') {
    notes[step] = { message, kind };
  }

  async function act(step, button, action) {
    if (button.disabled) return;
    button.disabled = true;
    // Only the latest action's message stays; older ones would read as if they were about this action.
    for (const key of Object.keys(notes)) delete notes[key];
    try {
      await action();
    } catch (error) {
      note(step, error.message, 'error');
    }
    await reload();
    // Other tabs show counts derived from these records (오답노트 tab); keep them current (moa-lessons #2).
    await onChange();
  }

  function confirmLeave() {
    return !dirty || window.confirm('저장하지 않은 내용이 있습니다. 저장하지 않고 옮길까요?');
  }

  // Switches the shown record without drawing (callers draw once everything it needs is loaded).
  function setCurrent(session, step = 1) {
    current = session ? structuredClone(session) : emptySession();
    openStep = step;
    dirty = false;
    shownEvidence = 0;
    evidenceFocus = null;
    review = { cycle: null, dateBlocker: null };
    logs = [];
    logForm = null;
    summaryForm = null;
    Object.assign(ai, { info: null, rights: '', agreed: false, response: '' });
    for (const key of Object.keys(notes)) delete notes[key];
  }

  // The request to copy, or what the consent must cover first; only a record in step 3 or later can be sent.
  function loadAi() {
    return current.id && current.locked
      ? api.aiRequest(current.id, { provider: ai.provider, purpose: ai.purpose }) : Promise.resolve(null);
  }

  function select(session, step = 1) {
    setCurrent(session, step);
    render();
    // The review-date lock and the learning logs are loaded separately; draw again once they arrive.
    if (current.id) {
      const id = current.id;
      Promise.all([api.reviewInfo(id), api.studyLogs(id), loadAi()]).then(([info, loaded, aiInfo]) => {
        if (current.id !== id) return;
        review = info;
        logs = loaded;
        ai.info = aiInfo;
        rerender();
      }).catch(() => {});
    }
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
    // After a new registration the textbook gets a new id: pages chosen before cannot be compared (or even shown in
    // the list below), so they are named here and can be dropped in one step.
    const stale = current.id ? staleEvidence(current, source) : [];
    const staleNode = stale.length === 0 ? null : el('div', { class: 'stale-evidence' },
      el('p', { text: `지금 교재에 없는 근거 ${stale.length}개: ${stale.map(ref => `PDF ${ref.pdfPageIndex}쪽`).join(', ')}. 자료를 다시 등록하기 전에 고른 쪽이라 대조에 쓸 수 없습니다.` }),
      guardedButton({ label: '지금 교재에 없는 근거 빼기', kind: 'secondary', step: 2,
        blocker: () => (dirty ? '1단에서 바꾼 내용을 먼저 저장하세요.' : null), onClick: async () => {
          current = await api.saveStudySession({ ...draft(), evidence: current.evidence.filter(ref => !stale.includes(ref)) });
          dirty = false;
          note(2, '지금 교재에 없는 근거를 뺐습니다. 지금 교재에서 근거를 다시 고르세요.');
        } }));
    return [
      staleNode,
      ...evidenceChoices(),
      el('p', { class: 'muted', text: '「원문과 대조 시작」을 누르면 문제·첫 답안·고른 근거가 고정됩니다. 다른 조건으로 하려면 나중에 「다시 풀기」를 씁니다.' }),
      guardedButton({ label: '원문과 대조 시작', step: 2,
        blocker: () => (dirty ? '1단에서 바꾼 내용을 먼저 저장하세요.'
          : stale.length > 0 ? '지금 교재에 없는 근거가 있습니다. 위의 「지금 교재에 없는 근거 빼기」를 누르세요.'
            : lockBlocker(current.id ? current : null)),
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
      aiSection(),
    ];
  }

  // ---- B 내 AI에게 검토받기: the app builds the request and stores the pasted answer; it sends nothing ----

  function aiSection() {
    const provider = el('select', { 'data-ai-field': 'provider' },
      ...PROVIDERS.map(name => el('option', { value: name, text: name })));
    provider.value = ai.provider;
    const purpose = el('select', { 'data-ai-field': 'purpose' },
      ...Object.entries(PURPOSES).map(([key, label]) => el('option', { value: key, text: label })));
    purpose.value = ai.purpose;
    for (const [node, key] of [[provider, 'provider'], [purpose, 'purpose']]) {
      node.addEventListener('change', () => {
        ai[key] = node.value;
        Object.assign(ai, { info: null, rights: '', agreed: false });
        rerender();
        const id = current.id;
        loadAi().then(info => {
          if (current.id !== id) return;
          ai.info = info;
          rerender();
        }).catch(error => {
          note('ai', error.message, 'error');
          rerender();
        });
      });
    }
    const parts = [
      el('h4', { text: '내 AI에게 검토받기(선택)' }),
      el('p', { class: 'muted', text: '앱은 아무것도 보내지 않습니다. 요청문을 복사해 내가 쓰는 AI 서비스에 붙여 넣고, 받은 답을 여기에 붙여 넣습니다. 붙여 넣은 답은 「AI 추정」으로만 저장하며 공식 채점이 아닙니다.' }),
      el('div', { class: 'study-grid' }, el('label', {}, 'AI 서비스', provider), el('label', {}, '요청 목적', purpose)),
    ];
    if (!ai.info) parts.push(el('p', { class: 'muted', text: '요청문을 준비하고 있습니다…' }));
    else if (!ai.info.consent) parts.push(consentCard());
    else parts.push(...requestBlock());
    parts.push(stepNote('ai'));
    if ((current.aiReviews ?? []).length > 0) parts.push(reviewList());
    return el('section', { class: 'ai-section' }, ...parts);
  }

  // PRD 4: what goes where and for what, the textbook-rights question, then an explicit check before any request.
  function consentCard() {
    const titles = ai.info.sourceTitles.join(', ') || '고른 교재';
    const rights = el('fieldset', { class: 'ai-rights' },
      el('legend', { text: `교재 원문(${titles})을 ${ai.provider}에 보내도 되나요?` }),
      ...[['confirmed', '보내도 됩니다 — 이 서비스에 넣어도 되는 자료임을 확인했습니다'],
        ['unknown', '모르겠습니다 — 교재 원문은 빼고 요청합니다']].map(([value, label]) => {
        const radio = el('input', { type: 'radio', name: 'ai-rights', value });
        radio.checked = ai.rights === value;
        radio.addEventListener('change', () => {
          ai.rights = value;
          refreshBlockers();
        });
        return el('label', { class: 'cause-choice' }, radio, ` ${label}`);
      }));
    const agree = el('input', { type: 'checkbox', 'data-ai-field': 'agree' });
    agree.checked = ai.agreed;
    agree.addEventListener('change', () => {
      ai.agreed = agree.checked;
      refreshBlockers();
    });
    return el('div', { class: 'ai-consent' },
      el('p', {}, el('strong', { text: `${ai.provider}에 붙여 넣게 되는 것` })),
      el('ul', {},
        el('li', { text: '문제, 첫 답안, 3단에 저장한 「빠진 것」과 「잘못 알고 있던 것」' }),
        el('li', { text: `교재 원문: 아래에서 「보내도 됩니다」를 고른 경우에만(고른 쪽의 글자, ${REQUEST_SOURCE_LIMIT.toLocaleString('ko-KR')}자까지)` }),
        el('li', { text: `목적: ${PURPOSES[ai.purpose]}` })),
      el('p', { class: 'muted', text: '붙여 넣은 내용은 그 서비스의 정책에 따라 처리되며, 이미 보낸 내용은 이 앱에서 되돌릴 수 없습니다. 이름·학번 같은 개인정보는 문제와 답안에 적지 마세요. 동의는 「내 기록」 탭에서 철회할 수 있습니다.' }),
      rights,
      el('label', { class: 'cause-choice' }, agree, ` 위 내용을 내가 직접 ${ai.provider}에 붙여 넣는다는 것을 이해했습니다.`),
      guardedButton({ label: '동의하고 요청문 만들기', step: 'ai',
        blocker: () => (!ai.rights ? '교재 원문을 보내도 되는지 고르세요.' : !ai.agreed ? '확인란에 체크하세요.' : null),
        onClick: async () => {
          await api.grantAiConsent({ sessionId: current.id, provider: ai.provider, purpose: ai.purpose, sourceRights: ai.rights });
          note('ai', '동의를 기록했습니다. 요청문을 복사해 AI 서비스에 붙여 넣으세요.');
        } }));
  }

  function requestBlock() {
    const { consent, request } = ai.info;
    const text = el('textarea', { 'data-form-field': 'ai-request', rows: '8', readonly: true, 'aria-label': '요청문' });
    text.value = request;
    const copy = guardedButton({ label: '요청문 복사', kind: 'secondary', step: 'ai',
      blocker: () => (dirty ? '바꾼 내용을 먼저 「대조 내용 저장」으로 저장하세요. 저장한 내용만 요청문에 들어갑니다.' : null),
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(request);
          note('ai', '복사했습니다. AI 서비스의 입력창에 붙여 넣으세요.');
        } catch {
          note('ai', '자동 복사가 되지 않았습니다. 요청문 글상자를 누르고 전체 선택(Ctrl+A)한 뒤 복사(Ctrl+C)하세요.', 'error');
        }
      } });
    const response = el('textarea', { 'data-form-field': 'ai-response', rows: '8' });
    response.value = ai.response;
    response.addEventListener('input', () => {
      ai.response = response.value;
      refreshBlockers();
    });
    const save = guardedButton({ label: 'AI 답 저장', step: 'ai',
      blocker: () => (!ai.response.trim() ? 'AI의 답을 붙여 넣어 주세요.'
        : ai.response.trim().length > RESPONSE_LIMIT ? `AI의 답은 ${RESPONSE_LIMIT.toLocaleString('ko-KR')}자까지 저장합니다.` : null),
      onClick: async () => {
        const result = await api.saveAiReview(current.id, { provider: ai.provider, purpose: ai.purpose, response: ai.response });
        ai.response = '';
        note('ai', result.candidates > 0
          ? `저장했습니다. 학습로그 후보 ${result.candidates}개는 아래 「학습로그」에서 승인하거나 무시하세요.`
          : ai.purpose === 'cause'
            ? (result.cause ? '저장했습니다. 제안된 원인은 아래 「저장한 AI 답」에서 4단에 넣을 수 있습니다.'
              : '저장했습니다. 답에서 「주된 원인:」 줄을 찾지 못해 원인 제안은 없습니다.')
            : '저장했습니다. 답에서 학습로그 후보를 찾지 못했습니다.');
      } });
    return [
      el('p', { class: 'muted ai-consent-line', text: `${consent.provider} · ${PURPOSES[ai.purpose]} 동의 ${consent.grantedAt.slice(0, 10)} · 교재 원문 ${consent.sourceRights === 'confirmed' ? '포함' : '빼고 요청'}` }),
      el('label', {}, '① 이 요청문을 복사해 AI 서비스에 붙여 넣습니다', text),
      copy,
      el('label', {}, '② AI의 답을 그대로 붙여 넣습니다', response),
      save,
    ];
  }

  function reviewList() {
    return el('div', { class: 'ai-reviews' },
      el('h4', { text: `저장한 AI 답 (${current.aiReviews.length})` }),
      // The newest answer is shown open, so its cause suggestion and button are in sight; older ones stay folded.
      ...[...current.aiReviews].reverse().map((item, index) => {
        const cause = item.purpose === 'cause' ? parseCauseSuggestion(item.response) : null;
        const applied = cause && current.mainCause === cause.mainCause
          && cause.otherCauses.every(other => (current.otherCauses ?? []).includes(other));
        return el('details', { class: 'ai-review', 'data-ai-review': item.id, open: index === 0 },
          el('summary', {}, el('span', { class: 'ai-badge', text: 'AI 추정 · 공식 채점 아님' }),
            ` ${PURPOSES[item.purpose]} · ${item.provider} · ${item.at.slice(0, 10)}${item.includedSource ? '' : ' · 교재 원문 없이 요청'}`),
          ...item.warnings.map(warning => el('p', { class: 'ai-warning', text: warning })),
          cause ? el('p', { class: 'muted', text: `제안된 원인: ${cause.mainCause}${cause.otherCauses.length > 0 ? ` · 함께: ${cause.otherCauses.join(', ')}` : ''}` }) : null,
          cause ? localButton('4단에 원인 넣기', applied ? '이미 4단에 들어 있습니다.' : null, () => {
            current.mainCause = cause.mainCause;
            current.otherCauses = cause.otherCauses;
            dirty = true;
            openStep = 4;
            note(4, 'AI가 제안한 원인을 넣었습니다(AI 추정). 맞는지 확인한 뒤 「저장」을 누르세요.');
            rerender();
          }, 'secondary') : null,
          el('pre', { class: 'page-text', text: item.response }));
      }));
  }

  function step4() {
    if (!current.locked) {
      return [el('p', { class: 'blocked-reason', text: '잠김: 3단에서 원문과 대조한 뒤에 고쳐 씁니다.' })];
    }
    const dateLocked = Boolean(review.dateBlocker);
    const clearDate = el('button', { type: 'button', class: 'link-button', text: '복습일 지우기', disabled: dateLocked });
    clearDate.addEventListener('click', () => {
      field('reviewDate').value = '';
      dirty = true;
    });
    const main = el('select', { 'data-field': 'mainCause' },
      el('option', { value: '', text: '고르지 않음 — 오답노트에 넣지 않음' }),
      ...CAUSES.map(cause => el('option', { value: cause, text: cause })));
    main.value = current.mainCause ?? '';
    main.addEventListener('change', () => {
      dirty = true;
      rerender();
    });
    const others = el('fieldset', { class: 'cause-others' }, el('legend', { text: '함께 나타난 원인(여러 개 고를 수 있음)' }),
      ...CAUSES.filter(cause => cause !== current.mainCause).map(cause => {
        const box = el('input', { type: 'checkbox', 'data-other-cause': '', value: cause });
        box.checked = (current.otherCauses ?? []).includes(cause);
        box.addEventListener('change', () => { dirty = true; });
        return el('label', { class: 'cause-choice' }, box, ` ${cause}`);
      }));
    return [
      textInput('revision', '수정 답안', { multiline: true, rows: 7 }),
      textInput('reflection', '복습 메모(다음에 먼저 볼 것)', { multiline: true, rows: 3 }),
      el('div', { class: 'cause-block' },
        el('h4', { text: '오답 원인' }),
        el('p', { class: 'muted', text: '주된 원인을 고르면 이 기록이 「오답노트」에 들어가고, 복습일이 되면 그날 계획의 복습 몫에 배정됩니다.' }),
        el('label', {}, '주된 원인', main),
        current.mainCause ? others : null,
        current.mainCause ? textInput('nextAction', '다음 연습에서 할 일(두 가지까지)', { multiline: true, rows: 2 }) : null,
        current.mainCause ? textInput('reviewMinutes', '복습에 쓸 시간(분, 5~120)', { type: 'number' }) : null),
      el('div', { class: 'review-date' },
        textInput('reviewDate', '복습일(직접 고릅니다)', { type: 'date', readOnly: dateLocked }), clearDate,
        dateLocked ? el('span', { class: 'blocked-reason', 'data-reason': '복습일', text: `잠김: ${review.dateBlocker}` }) : null),
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
            // act() reloads and draws once; drawing here would show the new record beside a stale list.
            setCurrent(retake, 1);
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
          setCurrent(null);
        });
      });
      return el('p', { class: 'study-foot' }, remove);
    })() : null;
    // replaceChildren() writes null as the text "null"; a new record has no logs, wrap-up or delete link yet.
    workNode.replaceChildren(...[header, ...steps, current.id ? logSection() : null, current.id ? summarySection() : null,
      actions].filter(Boolean));
  }

  function render() {
    renderList();
    renderWork();
  }

  // Redraw after opening a step, searching or switching evidence within the same record: typed but unsaved
  // values are taken from the form first so they survive the redraw.
  function rerender() {
    Object.assign(current, pick(draft()));
    captureForms();
    render();
  }

  function captureForms() {
    const value = name => workNode.querySelector(`[data-form-field="${name}"]`)?.value;
    if (logForm) {
      for (const name of ['title', 'content', 'verificationStatus']) logForm[name] = value(`log-${name}`) ?? logForm[name];
    }
    if (summaryForm) {
      for (const name of ['title', 'content']) summaryForm[name] = value(`summary-${name}`) ?? summaryForm[name];
    }
  }

  // ---- A-4 학습로그와 마무리 ----

  function formInput(name, label, value, { multiline = false, rows = 3, onInput } = {}) {
    const control = multiline
      ? el('textarea', { 'data-form-field': name, rows: String(rows) })
      : el('input', { 'data-form-field': name, type: 'text' });
    control.value = value ?? '';
    if (onInput) control.addEventListener('input', onInput);
    return el('label', {}, label, control);
  }

  // A button with the reason it is disabled, for actions that only open a form (no stored change).
  function localButton(label, blocker, onClick, kind = '') {
    const button = el('button', { type: 'button', class: kind, 'data-action': label, disabled: Boolean(blocker) });
    button.textContent = label;
    button.addEventListener('click', onClick);
    return el('div', { class: 'guarded' }, button,
      el('span', { class: 'blocked-reason', 'data-reason': label, text: blocker ? `잠김: ${blocker}` : '' }));
  }

  function pageList(pages) {
    return pages.map(page => `${page.pdfPageIndex}쪽${page.printedPageLabel ? `(인쇄 ${page.printedPageLabel})` : ''}`).join(', ');
  }

  function logFormNode() {
    const verification = el('select', { 'data-form-field': 'log-verificationStatus' },
      ...Object.entries(VERIFICATION).filter(([key]) => key !== 'llm_inferred' || logForm.verificationStatus === 'llm_inferred')
        .map(([key, label]) => el('option', { value: key, text: label })));
    verification.value = logForm.verificationStatus;
    const save = guardedButton({ label: logForm.approve ? '고쳐서 승인' : '로그 저장', step: 'log', blocker: () => logBlocker({ content:
      workNode.querySelector('[data-form-field="log-content"]')?.value ?? logForm.content }), onClick: async () => {
      captureForms();
      await api.saveStudyLog({ id: logForm.id, sessionId: current.id, type: logForm.type, title: logForm.title,
        content: logForm.content, verificationStatus: logForm.verificationStatus, approve: Boolean(logForm.approve) });
      note('log', logForm.approve ? '고친 내용으로 승인했습니다.' : '학습로그를 저장했습니다.');
      logForm = null;
    } });
    const cancel = el('button', { type: 'button', class: 'link-button', text: '취소' });
    cancel.addEventListener('click', () => {
      logForm = null;
      rerender();
    });
    return el('div', { class: 'log-form' },
      el('p', { class: 'log-form-type', text: `${logForm.approve ? 'AI 후보 고치기' : logForm.id ? '로그 고치기' : '새 로그'} · ${LOG_TYPES[logForm.type].label}` }),
      formInput('log-title', '제목(비우면 내용 앞부분으로 만듭니다)', logForm.title),
      formInput('log-content', '내용', logForm.content, { multiline: true, rows: 4, onInput: refreshBlockers }),
      el('label', {}, '확인 상태', verification),
      el('div', { class: 'actions' }, save, cancel));
  }

  function logItem(log) {
    const edit = el('button', { type: 'button', class: 'link-button', text: '고치기' });
    edit.addEventListener('click', () => {
      captureForms();
      logForm = { id: log.id, type: log.type, title: log.title, content: log.content, verificationStatus: log.verificationStatus };
      rerender();
    });
    const remove = el('button', { type: 'button', class: 'link-button danger-link', text: '지우기' });
    remove.addEventListener('click', () => {
      if (!window.confirm('이 학습로그를 지웁니다. 지울까요?')) return;
      act('log', remove, async () => {
        await api.deleteStudyLog(log.id);
        note('log', '학습로그를 지웠습니다.');
      });
    });
    return el('li', { class: 'log-item', 'data-log-id': log.id },
      el('div', { class: 'log-head' }, el('span', { class: 'log-chip', text: LOG_TYPES[log.type].label }),
        el('strong', { text: log.title })),
      // A short log's automatic title is its whole content; show it once.
      log.content.replace(/\s+/g, ' ').trim() === log.title ? null : el('p', { class: 'log-content', text: log.content }),
      el('p', { class: 'muted log-meta', text: [VERIFICATION[log.verificationStatus],
        log.sourcePages.length > 0 ? `근거 ${pageList(log.sourcePages)}` : null,
        log.origin === 'llm' ? 'AI 후보에서 승인' : null].filter(Boolean).join(' · ') }),
      el('div', { class: 'log-actions' }, edit, remove));
  }

  // A pending AI candidate: 승인 / 고쳐서 승인 / 무시 (Moa's pending → approved | ignored).
  function candidateItem(log) {
    const decide = (label, action, message) => {
      const button = el('button', { type: 'button', class: action === 'ignore' ? 'link-button' : 'secondary', text: label });
      button.addEventListener('click', () => act('log', button, async () => {
        await api.decideStudyLog(log.id, action);
        note('log', message);
      }));
      return button;
    };
    const edit = el('button', { type: 'button', class: 'secondary', text: '고쳐서 승인' });
    edit.addEventListener('click', () => {
      captureForms();
      logForm = { id: log.id, type: log.type, title: log.title, content: log.content,
        verificationStatus: log.verificationStatus, approve: true };
      rerender();
      workNode.querySelector('[data-form-field="log-content"]')?.focus();
    });
    return el('li', { class: 'log-item candidate', 'data-log-id': log.id },
      el('div', { class: 'log-head' }, el('span', { class: 'log-chip', text: LOG_TYPES[log.type].label }),
        el('strong', { text: log.title })),
      log.content.replace(/\s+/g, ' ').trim() === log.title ? null : el('p', { class: 'log-content', text: log.content }),
      el('p', { class: 'muted log-meta', text: log.verificationStatus === 'llm_inferred' ? 'AI 추정'
        : `AI 추정 · ${VERIFICATION[log.verificationStatus]}` }),
      el('div', { class: 'log-actions' }, decide('승인', 'approve', '후보를 학습로그로 승인했습니다.'), edit,
        decide('무시', 'ignore', '후보를 무시했습니다. 요약과 Wiki 내보내기에 들어가지 않습니다.')));
  }

  function logSection() {
    const buttons = el('div', { class: 'log-buttons', 'aria-label': '학습로그 유형' }, ...MANUAL_LOG_TYPES.map(type => {
      const button = el('button', { type: 'button', class: 'secondary', 'data-log-type': type, text: LOG_TYPES[type].label });
      button.addEventListener('click', () => {
        captureForms();
        logForm = { id: null, type, title: '', content: logPrefill(type, current),
          verificationStatus: defaultVerification(type, current) };
        rerender();
        workNode.querySelector('[data-form-field="log-content"]')?.focus();
      });
      return button;
    }));
    // Logs saved before B have no pending state; they are the learner's own.
    const approved = logs.filter(log => (log.status ?? 'approved') === 'approved');
    const pending = logs.filter(log => log.status === 'pending');
    const ignored = logs.filter(log => log.status === 'ignored').length;
    return el('section', { class: 'log-section' },
      el('h4', { text: `학습로그 (${approved.length})` }),
      el('p', { class: 'muted', text: '공부하면서 남길 내용을 유형별로 적습니다. 「오개념 수정」·「보충 필요」·「미해결 질문」·「확인 필요」·「직접 메모」는 3·4단에서 적은 내용으로 시작합니다. 적은 로그는 나중에 개인 Wiki로 내보낼 수 있습니다.' }),
      buttons,
      logForm ? logFormNode() : null,
      pending.length > 0 ? el('div', { class: 'candidate-block' },
        el('h5', { text: `AI가 제안한 후보 (${pending.length}) · 아직 학습로그가 아닙니다` }),
        el('p', { class: 'muted', text: '승인한 후보만 학습로그가 되어 학습 마무리와 Wiki 내보내기에 들어갑니다.' }),
        el('ul', { class: 'log-list' }, ...pending.map(candidateItem))) : null,
      approved.length > 0 ? el('ul', { class: 'log-list' }, ...approved.map(logItem)) : null,
      ignored > 0 ? el('p', { class: 'muted', text: `무시한 후보 ${ignored}개는 목록에서 뺐습니다.` }) : null,
      stepNote('log'));
  }

  function summarySection() {
    const parts = [el('h4', { text: '학습 마무리' })];
    if (summaryForm) {
      const approve = guardedButton({ label: '요약 승인', step: 'summary', blocker: () => (
        (workNode.querySelector('[data-form-field="summary-content"]')?.value ?? summaryForm.content).trim()
          ? null : '요약 내용을 적어 주세요.'), onClick: async () => {
        captureForms();
        await api.approveStudySummary(current.id, { title: summaryForm.title, content: summaryForm.content });
        summaryForm = null;
        note('summary', '요약을 승인했습니다. 이 기록의 요약은 하나이며, 다시 마무리하면 이 요약을 고칩니다.');
      } });
      const cancel = el('button', { type: 'button', class: 'link-button', text: '취소' });
      cancel.addEventListener('click', () => {
        summaryForm = null;
        rerender();
      });
      parts.push(el('p', { class: 'muted', text: '오늘 공부를 한 번에 볼 수 있게 정리합니다. 내용을 고친 뒤 승인하세요.' }),
        formInput('summary-title', '제목', summaryForm.title),
        formInput('summary-content', '요약', summaryForm.content, { multiline: true, rows: 8, onInput: refreshBlockers }),
        el('div', { class: 'actions' }, approve, cancel));
    } else if (current.summary) {
      parts.push(el('div', { class: 'summary-card' },
        el('strong', { text: current.summary.title }),
        el('p', { class: 'muted', text: `승인 ${current.summary.approvedAt.slice(0, 10)}` }),
        el('p', { class: 'log-content', text: current.summary.content })),
      localButton('다시 마무리', null, () => {
        captureForms();
        summaryForm = { title: current.summary.title, content: current.summary.content };
        rerender();
      }, 'secondary'));
    } else {
      parts.push(localButton('학습 마무리', summaryBlocker(current), () => {
        captureForms();
        summaryForm = summaryDraft(current, logs);
        rerender();
      }));
    }
    parts.push(stepNote('summary'));
    return el('section', { class: 'summary-section' }, ...parts);
  }

  // Reloads records and redraws everything (moa-lessons #2); keeps unsaved form values.
  async function reload() {
    [sessions, source] = await Promise.all([api.studySessions(), api.sourceView()]);
    let switched = false;
    if (pendingOpen) {
      const target = sessions.find(item => item.id === pendingOpen.id);
      // Switching records from another tab: unsaved edits of the previous record must not leak into this one.
      if (target && (target.id === current.id || confirmLeave())) {
        switched = target.id !== current.id;
        // Draw only after the review info below is loaded, so a locked date never looks editable.
        setCurrent(target, pendingOpen.step);
      }
      pendingOpen = null;
    }
    const id = current.id;
    const stored = id ? sessions.find(item => item.id === id) ?? null : null;
    const [loadedReview, loadedLogs, aiInfo] = stored
      ? await Promise.all([api.reviewInfo(id), api.studyLogs(id),
        stored.locked ? api.aiRequest(id, { provider: ai.provider, purpose: ai.purpose }) : null])
      : [{ cycle: null, dateBlocker: null }, [], null];
    // The learner moved to another record (or 「새 기록」) while this loaded; that view is already drawn.
    if (current.id !== id) {
      renderList();
      return;
    }
    review = loadedReview;
    logs = loadedLogs;
    ai.info = aiInfo;
    // What the form holds now, taken after loading: text typed while the records loaded must survive the redraw.
    const keep = dirty && !switched ? draft() : null;
    if (id) current = stored ? { ...structuredClone(stored), ...(keep ? pick(keep) : {}) } : emptySession();
    else if (keep) Object.assign(current, pick(keep));
    render();
  }

  function pick(values) {
    const editable = current.locked ? FIELDS.filter(name => !['question', 'firstAnswer'].includes(name)) : FIELDS;
    return { ...Object.fromEntries(editable.map(name => [name, values[name]])), otherCauses: values.otherCauses };
  }

  // Reloading or closing the page would drop typed answers without a word; let the browser ask first.
  window.addEventListener('beforeunload', event => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  newButton.addEventListener('click', () => {
    if (!confirmLeave()) return;
    select(null);
  });

  return {
    update: reload,
    // Opens a record from another tab (오답노트); the view loads it on its next update.
    open(id, step = 4) {
      pendingOpen = { id, step };
    },
  };
}
