// 문제 풀기 (D024): one screen instead of the four steps of v0.9 — the question and my answer first, then
// 「교재랑 맞춰 보기」 shows the textbook pages that match the question beside my answer (my answer stays fixed),
// then what I missed, the rewritten answer, an optional reason and the day to see it again. AI and notes wait under
// 「더 보기」. Checked against docs/moa-lessons.md: a disabled button says what to do first (#1), every action redraws
// from stored records (#2), and nothing asks the learner to learn names before studying (#11).
import { causeLabel, saveBlocker, searchPages, sessionTitle, STUDENT_CAUSES } from './src/study-core.mjs';
import { PROVIDERS, RESPONSE_LIMIT } from './src/ai-bridge.mjs';

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

function pad(number) {
  return String(number).padStart(2, '0');
}

function dayAfter(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 「PDF 12쪽(책 10쪽)」: the PDF viewer's page number, and the printed one when the PDF has it.
function pageName(page) {
  return `PDF ${page.pdfPageIndex}쪽${page.printedPageLabel ? `(책 ${page.printedPageLabel}쪽)` : ''}`;
}

function dayName(iso) {
  const date = new Date(`${iso}T00:00:00`);
  return `${date.getMonth() + 1}월 ${date.getDate()}일(${'일월화수목금토'[date.getDay()]})`;
}

const WHEN = [{ label: '내일', days: 1 }, { label: '3일 뒤', days: 3 }, { label: '일주일 뒤', days: 7 }];
const FIELDS = ['question', 'firstAnswer', 'missing', 'revision'];

function blank() {
  return { id: null, question: '', firstAnswer: '', evidence: [], locked: false, missing: '', revision: '',
    mainCause: '', reviewDate: '', aiReviews: [] };
}

// A problem's state in the learner's words, for the 「푼 문제」 list.
export function problemState(session) {
  if (session.locked && session.revision?.trim()) return '고쳐 씀';
  if (session.locked) return '맞춰 보는 중';
  if (session.firstAnswer?.trim()) return '내 답만 씀';
  return '쓰는 중';
}

export function createSolveView({ api, onChange = async () => {} }) {
  const work = document.querySelector('#solveWork');
  let sessions = [];
  let source = null;
  let current = blank();
  let dirty = false;
  let review = { cycle: null, dateBlocker: null };
  let logs = [];
  let message = null;
  let justSaved = false;
  let shownPage = 0;
  let pageQuery = '';
  let customDate = false;
  let moreOpen = false;
  let memo = '';
  const ai = { provider: PROVIDERS[0], info: null, rights: '', agreed: false, response: '' };
  let pendingOpen = null;
  let guards = [];

  const field = name => work.querySelector(`[data-field="${name}"]`);

  // The form's values; fields not on screen keep the stored ones.
  function draft() {
    const values = { id: current.id, parentId: current.parentId ?? null, evidence: current.evidence,
      mainCause: current.mainCause, reviewDate: current.reviewDate };
    for (const name of FIELDS) values[name] = field(name) ? field(name).value : current[name];
    return values;
  }

  function capture() {
    const values = draft();
    for (const name of FIELDS) current[name] = values[name];
    const memoNode = work.querySelector('[data-form-field="memo"]');
    if (memoNode) memo = memoNode.value;
    const more = work.querySelector('details.solve-more');
    if (more) moreOpen = more.open;
  }

  function say(text, kind = 'info') {
    message = { text, kind };
  }

  async function act(button, action) {
    if (button.disabled) return;
    button.disabled = true;
    message = null;
    try {
      await action();
    } catch (error) {
      say(error.message, 'error');
    }
    await reload();
    await onChange();
  }

  // A button with the thing to do first next to it when it cannot be pressed yet (moa-lessons #1).
  function guarded(label, blocker, onClick, kind = '') {
    const button = el('button', { type: 'button', class: kind, 'data-action': label, text: label });
    const reason = el('span', { class: 'blocked-reason', 'data-reason': label });
    const apply = () => {
      const why = blocker();
      button.disabled = Boolean(why);
      reason.textContent = why ?? '';
    };
    apply();
    guards.push(apply);
    button.addEventListener('click', () => act(button, onClick));
    return el('div', { class: 'guarded' }, button, reason);
  }

  function refreshGuards() {
    for (const apply of guards) apply();
  }

  function textArea(name, label, { rows = 4, readOnly = false, hint = null } = {}) {
    const area = el('textarea', { 'data-field': name, rows: String(rows), readonly: readOnly });
    area.value = current[name] ?? '';
    area.addEventListener('input', () => {
      dirty = true;
      refreshGuards();
    });
    return el('label', { class: 'solve-field' }, label, area, hint ? el('span', { class: 'field-help', text: hint }) : null);
  }

  function chips(items, pressed, onPick, { disabled = false, label }) {
    return el('div', { class: 'chips', role: 'group', 'aria-label': label }, ...items.map(item => {
      const chip = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(pressed(item)), disabled, text: item.label });
      chip.addEventListener('click', () => onPick(item));
      return chip;
    }));
  }

  // ---- before comparing: the question and my answer ----

  function writeStep() {
    return [
      textArea('question', '문제', { rows: 3 }),
      textArea('firstAnswer', '내 답', { rows: 6, hint: '교재를 보기 전에 아는 만큼 써 보세요. 틀려도 괜찮아요.' }),
      el('p', { class: 'field-help', text: '다 썼으면 눌러 주세요. 누르면 문제와 내 답은 더 고칠 수 없어요(처음 쓴 답을 남겨 두려고요). 문제 낱말이 들어간 교재 쪽이 옆에 나와요.' }),
      guarded('교재랑 맞춰 보기', () => saveBlocker(draft()), async () => {
        capture();
        current = await api.startCompare(draft());
        dirty = false;
        shownPage = 0;
        if (!source) say('교재 없이 맞춰 봐요. 보관함에서 교재 PDF를 넣으면 다음부터 교재 쪽이 옆에 나와요.');
        else if (current.evidence.length === 0) say('문제 낱말이 들어간 교재 쪽을 찾지 못했어요. 아래 「다른 쪽 보기」에서 골라 보세요.');
      }),
      // A saved problem not compared yet (e.g. from 「다시 풀기」) can still be removed.
      current.id ? el('p', { class: 'solve-foot' }, removeLink()) : null,
    ];
  }

  // ---- after comparing ----

  function compareBox() {
    const evidence = current.evidence;
    const page = evidence[Math.min(shownPage, evidence.length - 1)];
    const right = evidence.length === 0
      ? el('div', { class: 'compare-book' }, el('span', { class: 'tag', text: '교재' }),
        el('p', { class: 'muted', text: source ? '맞는 교재 쪽을 아직 고르지 않았어요.' : '넣은 교재가 없어요. 아는 것과 찾아본 것으로 맞춰 봐요.' }))
      : el('div', { class: 'compare-book' },
        el('div', { class: 'page-tabs', role: 'tablist' }, ...evidence.map((ref, index) => {
          const tab = el('button', { type: 'button', role: 'tab', 'aria-selected': String(index === shownPage), text: pageName(ref) });
          tab.addEventListener('click', () => {
            capture();
            shownPage = index;
            render();
          });
          return tab;
        })),
        el('pre', { class: 'page-text', text: page.text }),
        page.truncated ? el('p', { class: 'muted', text: '이 쪽은 앞부분만 담았어요. 나머지는 PDF에서 봐 주세요.' }) : null);
    return el('div', { class: 'compare' },
      el('div', { class: 'compare-mine' }, el('span', { class: 'tag', text: '내 답' }), el('pre', { class: 'page-text', text: current.firstAnswer })),
      right);
  }

  function otherPages() {
    if (!source) return null;
    const search = el('input', { type: 'search', 'aria-label': '교재에서 찾을 낱말', value: pageQuery, placeholder: '찾을 낱말' });
    search.addEventListener('input', () => {
      capture();
      pageQuery = search.value;
      render();
      work.querySelector('[aria-label="교재에서 찾을 낱말"]')?.focus();
    });
    const chosen = new Set(current.evidence.filter(ref => ref.sourceId === source.sourceId).map(ref => ref.pdfPageIndex));
    const hits = pageQuery.trim() ? searchPages(source.pages, pageQuery) : source.pages
      .filter(page => page.state === 'draft').map(page => ({ pdfPageIndex: page.pdfPageIndex, count: 0 }));
    const list = el('ul', { class: 'page-picks' }, ...hits.filter(hit => !chosen.has(hit.pdfPageIndex)).slice(0, 12).map(hit => {
      const page = source.pages.find(item => item.pdfPageIndex === hit.pdfPageIndex);
      const add = el('button', { type: 'button', class: 'link-button', text: `${pageName(page)} 펼치기${hit.count ? ` (${hit.count}곳)` : ''}` });
      add.addEventListener('click', () => act(add, async () => {
        capture();
        current = await api.addStudyEvidence(current.id, hit.pdfPageIndex);
        shownPage = current.evidence.length - 1;
      }));
      return el('li', {}, add);
    }));
    const details = el('details', { class: 'other-pages' }, el('summary', { text: '다른 쪽 보기' }), search, list);
    if (pageQuery || current.evidence.length === 0) details.open = true;
    return details;
  }

  function causeBlock() {
    const extra = current.mainCause && !STUDENT_CAUSES.some(item => item.cause === current.mainCause)
      ? [{ label: causeLabel(current.mainCause), cause: current.mainCause }] : [];
    return el('div', { class: 'solve-field' }, el('span', { class: 'field-title', text: '왜 틀렸을까요? (안 골라도 돼요)' }),
      chips([...STUDENT_CAUSES, ...extra], item => item.cause === current.mainCause, item => {
        capture();
        current.mainCause = current.mainCause === item.cause ? '' : item.cause;
        dirty = true;
        render();
      }, { label: '왜 틀렸을까요' }));
  }

  function whenBlock() {
    const locked = Boolean(review.dateBlocker);
    const presets = WHEN.map(item => ({ ...item, date: dayAfter(item.days) }));
    const isPreset = presets.some(item => item.date === current.reviewDate);
    const options = [...presets, { label: '날짜 고르기', date: null }, { label: '안 정할래요', date: '' }];
    const input = el('input', { type: 'date', 'aria-label': '다시 볼 날짜', value: current.reviewDate, disabled: locked, min: dayAfter(1) });
    input.addEventListener('change', () => {
      current.reviewDate = input.value;
      dirty = true;
      refreshGuards();
    });
    const showInput = customDate || (current.reviewDate && !isPreset);
    return el('div', { class: 'solve-field' }, el('span', { class: 'field-title', text: '언제 다시 볼까요?' }),
      chips(options, item => (item.date === null ? Boolean(showInput) : item.date === current.reviewDate && !showInput), item => {
        capture();
        customDate = item.date === null;
        if (item.date !== null) current.reviewDate = item.date;
        dirty = true;
        render();
      }, { disabled: locked, label: '언제 다시 볼까요' }),
      showInput ? input : null,
      el('span', { class: 'field-help', text: locked ? review.dateBlocker
        : current.reviewDate ? `${dayName(current.reviewDate)}부터 「오늘」 할 일에 들어가요(그날 복습 시간이 차면 다음 날로). 하루 공부 시간은 늘지 않아요.`
          : '고르면 그날 「오늘」 할 일에 들어가요.' }));
  }

  function fixStep() {
    return [
      el('div', { class: 'solve-question' }, el('span', { class: 'tag', text: '문제' }), el('pre', { class: 'page-text', text: current.question })),
      compareBox(),
      otherPages(),
      textArea('missing', '빠뜨렸거나 잘못 안 것', { rows: 3 }),
      textArea('revision', '고쳐 쓴 답', { rows: 6 }),
      causeBlock(),
      whenBlock(),
      guarded('저장', () => null, async () => {
        capture();
        current = await api.saveStudySession(draft());
        dirty = false;
        customDate = false;
        // Saving while the AI or memo box is open keeps that box on screen (the request needs the saved text).
        if (moreOpen) say('저장했어요.');
        else justSaved = true;
      }),
      moreBox(),
      el('p', { class: 'solve-foot' }, retakeLink(), ' ', removeLink()),
    ];
  }

  function retakeLink() {
    const retake = el('button', { type: 'button', class: 'link-button', text: '이 문제 다시 풀기' });
    retake.addEventListener('click', () => {
      if (dirty && !window.confirm('저장하지 않은 내용이 있어요. 저장하지 않고 다시 풀까요?')) return;
      act(retake, async () => {
        const copy = await api.retakeStudySession(current.id);
        pendingOpen = copy.id;
        say('같은 문제를 새로 풀어요. 내 답부터 다시 써 보세요.');
      });
    });
    return retake;
  }

  function removeLink() {
    const remove = el('button', { type: 'button', class: 'link-button danger-link', text: '이 문제 지우기' });
    remove.addEventListener('click', () => {
      if (!window.confirm('이 문제와 메모를 지워요. 보관 파일이 없으면 되돌릴 수 없어요. 지울까요?')) return;
      act(remove, async () => {
        await api.deleteStudySession(current.id);
        setCurrent(null);
        say('지웠어요.');
      });
    });
    return remove;
  }

  // ---- 더 보기: AI에게 물어보기 · 메모 ----

  function moreBox() {
    const details = el('details', { class: 'solve-more' }, el('summary', { text: '더 보기: AI에게 물어보기 · 메모 남기기' }),
      memoBox(), aiBox());
    details.open = moreOpen;
    details.addEventListener('toggle', () => { moreOpen = details.open; });
    return details;
  }

  function memoBox() {
    const approved = logs.filter(log => (log.status ?? 'approved') === 'approved');
    const pending = logs.filter(log => log.status === 'pending');
    const area = el('textarea', { 'data-form-field': 'memo', rows: '3', 'aria-label': '메모' });
    area.value = memo;
    area.addEventListener('input', () => {
      memo = area.value;
      refreshGuards();
    });
    return el('section', { class: 'memo-box' }, el('h3', { text: '메모' }),
      el('p', { class: 'field-help', text: '나중에 다시 볼 한 줄을 남겨요. 노트로 보낼 때 함께 가요.' }),
      area,
      guarded('메모 남기기', () => (memo.trim() ? null : '메모를 먼저 적어 주세요.'), async () => {
        await api.saveStudyLog({ sessionId: current.id, type: 'NOTE', content: memo });
        memo = '';
        say('메모를 남겼어요.');
      }, 'secondary'),
      pending.length > 0 ? el('div', { class: 'ai-memos' }, el('h4', { text: `AI가 제안한 메모 (${pending.length})` }),
        el('p', { class: 'field-help', text: '넣은 것만 내 메모가 돼요.' }),
        el('ul', { class: 'memo-list' }, ...pending.map(log => {
          const take = el('button', { type: 'button', class: 'secondary', text: '넣기' });
          take.addEventListener('click', () => act(take, () => api.decideStudyLog(log.id, 'approve')));
          const drop = el('button', { type: 'button', class: 'link-button', text: '빼기' });
          drop.addEventListener('click', () => act(drop, () => api.decideStudyLog(log.id, 'ignore')));
          return el('li', { class: 'memo candidate' }, el('strong', { text: log.title }),
            log.content.trim() === log.title ? null : el('p', { text: log.content }), el('div', { class: 'actions' }, take, drop));
        }))) : null,
      approved.length > 0 ? el('ul', { class: 'memo-list' }, ...approved.map(log => {
        const remove = el('button', { type: 'button', class: 'link-button danger-link', text: '지우기' });
        remove.addEventListener('click', () => act(remove, () => api.deleteStudyLog(log.id)));
        return el('li', { class: 'memo' }, el('p', { text: log.content }),
          log.origin === 'llm' ? el('span', { class: 'tag', text: 'AI 제안' }) : null, remove);
      })) : null);
  }

  function aiBox() {
    const provider = el('select', { 'aria-label': 'AI 서비스' }, ...PROVIDERS.map(name => el('option', { value: name, text: name })));
    provider.value = ai.provider;
    provider.addEventListener('change', async () => {
      capture();
      ai.provider = provider.value;
      Object.assign(ai, { info: null, rights: '', agreed: false });
      ai.info = await loadAi().catch(() => null);
      render();
    });
    const parts = [el('h3', { text: 'AI에게 물어보기' }),
      el('p', { class: 'field-help', text: '이 앱은 AI에 아무것도 보내지 않아요. 요청문을 복사해 내가 쓰는 AI에 붙여 넣고, 받은 답을 여기에 붙여 넣어요. AI 답은 참고용이고 채점이 아니에요.' }),
      el('label', { class: 'inline-field' }, '쓰는 AI', provider)];
    if (!ai.info) parts.push(el('p', { class: 'muted', text: '요청문을 준비하고 있어요…' }));
    else if (!ai.info.consent) parts.push(consentCard());
    else parts.push(...requestParts());
    if ((current.aiReviews ?? []).length > 0) parts.push(savedAnswers());
    return el('section', { class: 'ai-box' }, ...parts);
  }

  function consentCard() {
    const who = ai.provider === '기타' ? '그 AI' : ai.provider;
    const hasPages = current.evidence.length > 0;
    if (!hasPages) ai.rights = 'unknown';
    else if (!ai.rights) ai.rights = 'unknown';
    const rights = !hasPages ? null : el('div', { class: 'chips', role: 'radiogroup', 'aria-label': '교재 글도 보낼까요' },
      ...[['unknown', '교재 글은 빼고'], ['confirmed', '교재 글도 함께']].map(([value, label]) => {
        const chip = el('button', { type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(ai.rights === value),
          'aria-pressed': String(ai.rights === value), 'data-rights': value, text: label });
        chip.addEventListener('click', () => {
          ai.rights = value;
          for (const other of rights.querySelectorAll('.chip')) {
            const on = other.dataset.rights === value;
            other.setAttribute('aria-pressed', String(on));
            other.setAttribute('aria-checked', String(on));
          }
        });
        return chip;
      }));
    return el('div', { class: 'ai-consent' },
      el('p', { text: `${who}에 붙여 넣을 내용: 문제, 내 답, 빠뜨렸거나 잘못 안 것.` }),
      hasPages ? el('span', { class: 'field-help', text: '교재 글은 그 AI에 넣어도 되는 자료일 때만 함께 보내 주세요.' }) : null,
      rights,
      el('p', { class: 'field-help', text: '붙여 넣은 내용은 그 서비스로 가고, 여기서 되돌릴 수 없어요.' }),
      guarded('알겠어요, 요청문 만들기', () => null, async () => {
        await api.grantAiConsent({ sessionId: current.id, provider: ai.provider, purpose: 'review', sourceRights: ai.rights });
        say('요청문을 만들었어요. 복사해서 AI에 붙여 넣으세요.');
      }));
  }

  function requestParts() {
    const { request } = ai.info;
    const text = el('textarea', { 'data-form-field': 'ai-request', rows: '6', readonly: true, 'aria-label': '요청문' });
    text.value = request;
    const response = el('textarea', { 'data-form-field': 'ai-response', rows: '6', 'aria-label': 'AI 답' });
    response.value = ai.response;
    response.addEventListener('input', () => {
      ai.response = response.value;
      refreshGuards();
    });
    return [
      el('label', { class: 'solve-field' }, '① 요청문을 복사해 AI에 붙여 넣어요', text),
      guarded('요청문 복사', () => (dirty ? '바꾼 내용을 먼저 「저장」해 주세요. 저장한 내용만 요청문에 들어가요.' : null), async () => {
        try {
          await navigator.clipboard.writeText(request);
          say('복사했어요. AI 입력창에 붙여 넣으세요.');
        } catch {
          say('자동 복사가 안 됐어요. 요청문 칸을 누르고 전체 선택(Ctrl+A) 뒤 복사(Ctrl+C)해 주세요.', 'error');
        }
      }, 'secondary'),
      el('label', { class: 'solve-field' }, '② AI 답을 그대로 붙여 넣어요', response),
      guarded('AI 답 저장', () => (!ai.response.trim() ? 'AI 답을 먼저 붙여 넣어 주세요.'
        : ai.response.trim().length > RESPONSE_LIMIT ? `AI 답은 ${RESPONSE_LIMIT.toLocaleString('ko-KR')}자까지 저장할 수 있어요.` : null), async () => {
        const result = await api.saveAiReview(current.id, { provider: ai.provider, purpose: 'review', response: ai.response });
        ai.response = '';
        say(result.candidates > 0 ? `저장했어요. AI가 메모 ${result.candidates}개를 제안했어요. 위 「AI가 제안한 메모」에서 넣을지 골라 주세요.`
          : '저장했어요.');
      }),
    ];
  }

  function savedAnswers() {
    return el('div', { class: 'ai-reviews' }, el('h4', { text: `저장한 AI 답 (${current.aiReviews.length})` }),
      ...[...current.aiReviews].reverse().map((item, index) => {
        const details = el('details', { class: 'ai-review', 'data-ai-review': item.id },
          el('summary', {}, el('span', { class: 'ai-badge', text: 'AI 의견 · 채점 아님' }), ` ${item.provider} · ${item.at.slice(0, 10)}`),
          ...item.warnings.map(warning => el('p', { class: 'ai-warning', text: warning })),
          el('pre', { class: 'page-text', text: item.response }));
        details.open = index === 0;
        return details;
      }));
  }

  function loadAi() {
    return current.id && current.locked
      ? api.aiRequest(current.id, { provider: ai.provider, purpose: 'review' }) : Promise.resolve(null);
  }

  // ---- layout ----

  function savedCard() {
    const next = el('button', { type: 'button', text: '다음 문제' });
    next.addEventListener('click', () => {
      setCurrent(null);
      render();
      work.querySelector('[data-field="question"]')?.focus();
    });
    const back = el('button', { type: 'button', class: 'link-button', text: '이 문제 다시 보기' });
    back.addEventListener('click', () => {
      justSaved = false;
      render();
    });
    return el('div', { class: 'now-card saved-card' }, el('p', { class: 'eyebrow', text: '저장했어요' }),
      el('h2', { text: current.reviewDate ? `${dayName(current.reviewDate)}에 다시 볼게요` : '다시 볼 날은 정하지 않았어요' }),
      el('p', { class: 'muted', text: current.reviewDate ? '그날부터 「오늘」 할 일에 들어가요. 「보관함 → 다시 볼 문제」에서 언제든 볼 수 있어요.' : '「보관함 → 푼 문제」에서 다시 열 수 있어요.' }),
      el('div', { class: 'actions' }, next, back));
  }

  function render() {
    guards = [];
    const newButton = el('button', { type: 'button', class: 'secondary', text: '새 문제' });
    newButton.addEventListener('click', () => {
      if (dirty && !window.confirm('저장하지 않은 내용이 있어요. 저장하지 않고 새 문제로 갈까요?')) return;
      setCurrent(null);
      render();
    });
    const head = el('div', { class: 'solve-head' },
      // After comparing, the whole question is shown below; the heading names the step instead of repeating it.
      el('h2', { text: !current.id ? '새 문제' : current.locked && !justSaved ? '고쳐 쓰기' : sessionTitle(current) }),
      current.id ? newButton : null);
    const body = justSaved ? [savedCard()] : current.locked ? fixStep() : writeStep();
    const note = message ? el('p', { class: `step-note ${message.kind === 'error' ? 'error' : ''}`,
      role: message.kind === 'error' ? 'alert' : 'status', 'data-note': 'solve', text: message.text }) : null;
    work.replaceChildren(...[head, note, ...body].filter(Boolean));
  }

  function setCurrent(session) {
    current = session ? structuredClone(session) : blank();
    dirty = false;
    justSaved = false;
    shownPage = 0;
    pageQuery = '';
    customDate = false;
    moreOpen = false;
    memo = '';
    review = { cycle: null, dateBlocker: null };
    logs = [];
    Object.assign(ai, { info: null, rights: '', agreed: false, response: '' });
    message = null;
  }

  // Reloads records and redraws (moa-lessons #2); what was typed while loading survives.
  async function reload() {
    [sessions, source] = await Promise.all([api.studySessions(), api.sourceView()]);
    if (pendingOpen) {
      const target = sessions.find(item => item.id === pendingOpen);
      if (target && target.id !== current.id) {
        // The note that led here (「같은 문제를 새로 풀어요」) belongs to the problem being opened.
        const note = message;
        setCurrent(target);
        message = note;
      }
      pendingOpen = null;
    }
    const id = current.id;
    const stored = id ? sessions.find(item => item.id === id) ?? null : null;
    const [loadedReview, loadedLogs, aiInfo] = stored
      ? await Promise.all([api.reviewInfo(id), api.studyLogs(id),
        stored.locked ? api.aiRequest(id, { provider: ai.provider, purpose: 'review' }) : null])
      : [{ cycle: null, dateBlocker: null }, [], null];
    if (current.id !== id) return;
    review = loadedReview;
    logs = loadedLogs;
    ai.info = aiInfo;
    if (dirty) capture();
    const kept = dirty ? Object.fromEntries(['missing', 'revision', 'mainCause', 'reviewDate', ...(stored?.locked ? [] : ['question', 'firstAnswer'])]
      .map(name => [name, current[name]])) : {};
    if (id) current = stored ? { ...structuredClone(stored), ...kept } : blank();
    render();
  }

  // Leaving with typed text asks first (the browser shows its own dialog).
  window.addEventListener('beforeunload', event => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  return {
    update: reload,
    // Opens a problem from 보관함; the view loads it on its next update.
    open(id) {
      if (id !== current.id && dirty && !window.confirm('저장하지 않은 내용이 있어요. 저장하지 않고 다른 문제를 열까요?')) return;
      pendingOpen = id;
    },
    // 「푼 문제」 in 보관함: newest first, each opens here.
    async renderSolved(node) {
      const all = await api.studySessions();
      node.replaceChildren(...(all.length === 0
        ? [el('li', { class: 'muted', text: '아직 푼 문제가 없어요. 「문제 풀기」에서 시작해 보세요.' })]
        : all.map(session => {
          const button = el('button', { type: 'button', class: 'solved-item' },
            el('span', { class: 'solved-title', text: sessionTitle(session) }),
            el('span', { class: 'solved-meta', text: [problemState(session), session.mainCause ? causeLabel(session.mainCause) : null,
              session.reviewDate ? `다시 볼 날 ${dayName(session.reviewDate)}` : null].filter(Boolean).join(' · ') }));
          button.addEventListener('click', () => {
            this.open(session.id);
            location.hash = '#solve';
          });
          return el('li', {}, button);
        })));
    },
  };
}
