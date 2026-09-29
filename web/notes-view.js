// 오답노트 (D023 A-3): sessions with a main cause, their review dates, and how each review stands against the plan.
// A due review joins that day's plan as a review task; 「복습했어요」 records its time there. Checked against
// docs/moa-lessons.md: every disabled action shows why (#1); every action redraws from stored records (#2).
import { CAUSES, completeBlocker } from './src/study-core.mjs';

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

function reviewLine(item) {
  const { cycle } = item;
  if (!cycle) return '복습일이 없습니다.';
  if (cycle.done) return `${cycle.date} 복습을 마쳤습니다. 다음 복습일을 고르세요.`;
  if (!cycle.due) return `복습일 ${cycle.date}`;
  const overdue = item.overdueDays > 0 ? ` · ${item.overdueDays}일 지남` : '';
  if (cycle.inCurrentPlan) return `오늘 복습할 차례${overdue} · 오늘 계획에 있음(기록 ${cycle.credited}/${cycle.minutes}분)`;
  if (cycle.deferredNow) return `복습할 차례${overdue} · 오늘은 복습 몫이 차서 배정되지 않음(뒤 계획으로 넘어감)`;
  if (cycle.planned) return `복습할 차례${overdue} · 지난 계획에 있음(기록 ${cycle.credited}/${cycle.minutes}분)`;
  return `복습할 차례${overdue} · 아직 계획에 들어가지 않음(「오늘 시작」이나 「남은 과업 다시 배정」을 누르면 들어갑니다)`;
}

export function createNotesView({ api, openInStudy, afterChange }) {
  const listNode = document.querySelector('#notesList');
  const scopeNode = document.querySelector('#notesScope');
  const causeNode = document.querySelector('#notesCause');
  const summaryNode = document.querySelector('#notesSummary');
  causeNode.append(...CAUSES.map(cause => el('option', { value: cause, text: cause })));
  let items = [];
  const messages = new Map();
  // Cards acted on stay in the 「지금 복습할 것」 list until the tab is opened again, so a finished review can get its
  // next date right away instead of vanishing with its message.
  const recent = new Set();

  async function act(id, button, action) {
    if (button.disabled) return;
    button.disabled = true;
    recent.add(id);
    try {
      messages.set(id, { text: await action(), kind: 'info' });
      await afterChange();
    } catch (error) {
      messages.set(id, { text: error.message, kind: 'error' });
    }
    await update();
  }

  function card(item) {
    const { session, cycle } = item;
    const id = session.id;
    const blocker = completeBlocker(cycle);
    const done = el('button', { type: 'button', 'data-action': '복습했어요', disabled: Boolean(blocker) });
    done.textContent = '복습했어요';
    done.addEventListener('click', () => act(id, done, async () => {
      await api.completeReview(id);
      return '복습을 기록했습니다.';
    }));
    const open = el('button', { type: 'button', class: 'secondary', text: '학습실에서 열기' });
    open.addEventListener('click', () => openInStudy(id));
    const dateLocked = cycle && cycle.planned && !cycle.done;
    const date = el('input', { type: 'date', 'aria-label': '다음 복습일', value: cycle?.done ? '' : session.reviewDate,
      disabled: dateLocked });
    const saveDate = el('button', { type: 'button', class: 'secondary', 'data-action': '복습일 저장', disabled: dateLocked });
    saveDate.textContent = '복습일 저장';
    saveDate.addEventListener('click', () => act(id, saveDate, async () => {
      if (!date.value) throw new Error('복습일을 골라 주세요.');
      await api.saveStudySession({ id, reviewDate: date.value });
      return `다음 복습일을 ${date.value}로 정했습니다.`;
    }));
    const message = messages.get(id);
    return el('li', { class: `note-card${item.dueNow ? ' due' : ''}`, 'data-note-id': id },
      el('div', { class: 'note-head' },
        el('h3', { text: item.title }),
        el('span', { class: 'cause-chip', text: item.mainCause })),
      item.otherCauses.length > 0 ? el('p', { class: 'muted', text: `함께 나타난 원인: ${item.otherCauses.join(', ')}` }) : null,
      session.nextAction ? el('p', { text: `다음 연습: ${session.nextAction}` }) : null,
      el('p', { class: `note-status${item.dueNow ? ' due' : ''}`, 'data-status': '', text: reviewLine(item) }),
      el('div', { class: 'note-actions' },
        el('div', { class: 'guarded' }, done,
          blocker ? el('span', { class: 'blocked-reason', 'data-reason': '복습했어요', text: `잠김: ${blocker}` }) : null),
        open),
      el('div', { class: 'note-date' },
        el('label', {}, '다음 복습일(직접 고릅니다)', date), saveDate,
        dateLocked ? el('span', { class: 'blocked-reason', 'data-reason': '복습일 저장',
          text: '잠김: 계획에 들어간 복습을 먼저 마치세요.' }) : null),
      message ? el('p', { class: `step-note ${message.kind}`, role: message.kind === 'error' ? 'alert' : 'status', text: message.text }) : null);
  }

  function render() {
    const scope = scopeNode.value;
    const cause = causeNode.value;
    const shown = items.filter(item => (scope === 'all' || item.dueNow || recent.has(item.session.id))
      && (!cause || item.mainCause === cause));
    const dueCount = items.filter(item => item.dueNow).length;
    summaryNode.textContent = `오답 ${items.length}개 · 지금 복습할 것 ${dueCount}개`;
    listNode.replaceChildren(...(shown.length > 0 ? shown.map(card)
      : [el('li', { class: 'muted', text: items.length === 0
        ? '아직 오답노트가 없습니다. 학습실 4단에서 「주된 원인」을 고르면 여기에 모입니다.'
        : scope === 'due' ? '지금 복습할 오답이 없습니다. 「모든 오답」에서 전체를 볼 수 있습니다.' : '조건에 맞는 오답이 없습니다.' })]));
  }

  async function update({ fresh = false } = {}) {
    if (fresh) {
      recent.clear();
      messages.clear();
    }
    items = await api.notesView();
    render();
    return items;
  }

  scopeNode.addEventListener('change', render);
  causeNode.addEventListener('change', render);

  return { update };
}
