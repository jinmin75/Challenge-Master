// 다시 볼 문제 (D023 A-3, D024 names): problems with a day to see them again, and how each stands against today's
// plan. A due problem joins that day's plan within its review time; 「다시 봤어요」 records its time there. Checked
// against docs/moa-lessons.md: a disabled action says what to do first (#1); every action redraws from records (#2).
import { causeLabel, completeBlocker } from './src/study-core.mjs';

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

function dayName(iso) {
  const date = new Date(`${iso}T00:00:00`);
  return `${date.getMonth() + 1}월 ${date.getDate()}일(${'일월화수목금토'[date.getDay()]})`;
}

function reviewLine(item) {
  const { cycle } = item;
  if (!cycle) return '다시 볼 날이 없어요.';
  if (cycle.done) return `${dayName(cycle.date)}에 다시 봤어요. 다음에 볼 날을 골라 주세요.`;
  if (!cycle.due) return `다시 볼 날 ${dayName(cycle.date)}`;
  const overdue = item.overdueDays > 0 ? ` · ${item.overdueDays}일 지남` : '';
  if (cycle.inCurrentPlan) return `오늘 다시 볼 차례${overdue} · 「오늘」 할 일에 있어요(${cycle.credited}/${cycle.minutes}분)`;
  if (cycle.deferredNow) return `다시 볼 차례${overdue} · 오늘은 복습 시간이 다 차서 뒤로 넘어갔어요`;
  if (cycle.planned) return `다시 볼 차례${overdue} · 지난 할 일에 있었어요(${cycle.credited}/${cycle.minutes}분)`;
  return `다시 볼 차례${overdue} · 내일 「오늘」 할 일에 들어가요. 오늘 이미 봤다면 「다시 봤어요」를 눌러 주세요.`;
}

export function createNotesView({ api, openInStudy, afterChange }) {
  const listNode = document.querySelector('#notesList');
  const scopeNode = document.querySelector('#notesScope');
  const summaryNode = document.querySelector('#notesSummary');
  let items = [];
  const messages = new Map();
  // Cards acted on stay in the 「지금 볼 것」 list until the tab is opened again, so a finished review can get its
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
    const done = el('button', { type: 'button', 'data-action': '다시 봤어요', disabled: Boolean(blocker), text: '다시 봤어요' });
    done.addEventListener('click', () => act(id, done, async () => {
      await api.completeReview(id);
      return '다시 봤다고 적었어요.';
    }));
    const open = el('button', { type: 'button', class: 'secondary', text: '문제 열기' });
    open.addEventListener('click', () => openInStudy(id));
    const dateLocked = cycle && cycle.planned && !cycle.done;
    const date = el('input', { type: 'date', 'aria-label': '다음에 볼 날', value: cycle?.done ? '' : session.reviewDate,
      disabled: dateLocked });
    const saveDate = el('button', { type: 'button', class: 'secondary', 'data-action': '다시 볼 날 정하기', disabled: dateLocked,
      text: '다시 볼 날 정하기' });
    saveDate.addEventListener('click', () => act(id, saveDate, async () => {
      if (!date.value) throw new Error('날짜를 먼저 골라 주세요.');
      await api.saveStudySession({ id, reviewDate: date.value });
      return `${dayName(date.value)}에 다시 볼게요.`;
    }));
    const message = messages.get(id);
    return el('li', { class: `note-card${item.dueNow ? ' due' : ''}`, 'data-note-id': id },
      el('div', { class: 'note-head' },
        el('h3', { text: item.title }),
        item.mainCause ? el('span', { class: 'cause-chip', text: causeLabel(item.mainCause) }) : null),
      el('p', { class: `note-status${item.dueNow ? ' due' : ''}`, 'data-status': '', text: reviewLine(item) }),
      el('div', { class: 'note-actions' },
        el('div', { class: 'guarded' }, done,
          blocker ? el('span', { class: 'blocked-reason', 'data-reason': '다시 봤어요', text: blocker }) : null),
        open),
      el('div', { class: 'note-date' },
        el('label', {}, '다음에 볼 날', date), saveDate,
        dateLocked ? el('span', { class: 'blocked-reason', 'data-reason': '다시 볼 날 정하기',
          text: '다시 본 뒤에 날짜를 바꿀 수 있어요.' }) : null),
      message ? el('p', { class: `step-note ${message.kind}`, role: message.kind === 'error' ? 'alert' : 'status', text: message.text }) : null);
  }

  function render() {
    const scope = scopeNode.value;
    const shown = items.filter(item => scope === 'all' || item.dueNow || recent.has(item.session.id));
    const dueCount = items.filter(item => item.dueNow).length;
    summaryNode.textContent = `다시 볼 문제 ${items.length}개 · 지금 볼 것 ${dueCount}개`;
    listNode.replaceChildren(...(shown.length > 0 ? shown.map(card)
      : [el('li', { class: 'muted', text: items.length === 0
        ? '아직 다시 볼 문제가 없어요. 「문제 풀기」에서 「언제 다시 볼까요?」를 고르면 여기에 모여요.'
        : '지금 볼 문제가 없어요. 「보기」를 「전부」로 바꾸면 모두 볼 수 있어요.' })]));
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

  return { update };
}
