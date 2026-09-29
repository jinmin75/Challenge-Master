// Learning calendar and monthly check (PRD 6.1). Uses the page's api()/run() so busy state and errors stay shared.
// C: a colour summary beside the plan; the full calendar, day choices and monthly check open in a dialog.
const STATE_LABELS = {
  before_start: '등록 전',
  recorded: '기록 있음',
  rest: '휴식',
  needs_review: '확인 필요',
  missed: '누락 확인',
  late: '사후 기록',
  today: '오늘',
  future: '예정',
};

// The summary's second signal besides colour (a shape per state), matching the legend in index.html.
const STATE_MARKS = {
  recorded: '✓',
  needs_review: '?',
  missed: '×',
  late: '↺',
  rest: '–',
};

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter(child => child !== null && child !== undefined));
  return node;
}

function dayNumber(date) {
  return Number(date.slice(8));
}

function koreanDate(date) {
  const weekday = '일월화수목금토'[new Date(`${date}T00:00:00`).getDay()];
  return `${Number(date.slice(5, 7))}월 ${dayNumber(date)}일 (${weekday})`;
}

function shiftMonth(month, delta) {
  const [year, value] = month.split('-').map(Number);
  const date = new Date(year, value - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function addDays(date, days) {
  const next = new Date(`${date}T00:00:00`);
  next.setDate(next.getDate() + days);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

function cellLines(day) {
  const lines = [];
  if (['recorded', 'today'].includes(day.state) || (day.state === 'rest' && day.confirmedMinutes > 0)) {
    lines.push(day.assignedMinutes === null ? `확인 ${day.confirmedMinutes}분` : `확인 ${day.confirmedMinutes} / ${day.assignedMinutes}분`);
  }
  if (day.state === 'rest') lines.push(day.review ? '휴식(확인)' : '휴식');
  if (day.state === 'needs_review') lines.push('확인 필요');
  if (day.state === 'missed') lines.push(day.makeupScheduledFor > 0 ? `누락 · 보완 ${day.makeupScheduledFor}분` : '누락 확인');
  if (day.lateMinutes > 0) lines.push(`사후 기록 ${day.lateMinutes}분`);
  if (day.shortened) lines.push('줄임');
  if (day.skippedTasks > 0) lines.push(`건너뜀 ${day.skippedTasks}`);
  if (day.state === 'future' && day.plannedMinutes !== null) lines.push(`예정 ${day.plannedMinutes}분`);
  if (day.state === 'before_start') lines.push('등록 전');
  return lines;
}

export function createCalendar({ api, run, today }) {
  const nodes = {
    title: document.querySelector('#calendarTitle'),
    grid: document.querySelector('#calendarGrid'),
    prev: document.querySelector('#calendarPrev'),
    next: document.querySelector('#calendarNext'),
    dayTitle: document.querySelector('#dayTitle'),
    dayBody: document.querySelector('#dayBody'),
    monthTitle: document.querySelector('#monthTitle'),
    monthStats: document.querySelector('#monthStats'),
    needsReview: document.querySelector('#needsReviewList'),
    signals: document.querySelector('#calendarSignals'),
    dialog: document.querySelector('#calendarDialog'),
    close: document.querySelector('#calendarClose'),
    mini: document.querySelector('#calendarMini'),
    sideMonth: document.querySelector('#calendarSideMonth'),
    sidePrev: document.querySelector('#calendarSidePrev'),
    sideNext: document.querySelector('#calendarSideNext'),
    sideSummary: document.querySelector('#calendarSideSummary'),
    open: document.querySelector('#calendarOpen'),
  };
  if (!nodes.grid) return { update() {} };
  let opener = null;
  let month = today().slice(0, 7);
  let data = null;
  let selected = null;

  function post(path, body) {
    return api(path, { requestId: crypto.randomUUID(), ...body });
  }

  function select(date) {
    selected = date;
    renderGrid();
    renderDay();
  }

  // ---- C: summary beside the plan ----

  function renderMini() {
    nodes.sideMonth.textContent = `${Number(month.slice(0, 4))}년 ${Number(month.slice(5))}월`;
    const cells = ['일', '월', '화', '수', '목', '금', '토'].map(name => el('div', { class: 'dow', text: name }));
    const firstWeekday = new Date(`${month}-01T00:00:00`).getDay();
    for (let index = 0; index < firstWeekday; index += 1) cells.push(el('div', { class: 'mini-day blank', 'aria-hidden': 'true' }));
    for (const day of data.days) {
      const classes = ['mini-day', `state-${day.state}`];
      if (day.makeupMinutes > 0) classes.push('has-makeup');
      const button = el('button', { type: 'button', class: classes.join(' '), 'data-date': day.date,
        'aria-label': `${koreanDate(day.date)} ${STATE_LABELS[day.state]}${day.makeupMinutes > 0 ? `, 보완 +${day.makeupMinutes}분` : ''}. 자세히 보기` },
      el('span', { class: 'n', text: String(dayNumber(day.date)) }),
      STATE_MARKS[day.state] ? el('span', { class: 'mark', 'aria-hidden': 'true', text: STATE_MARKS[day.state] }) : null,
      day.makeupMinutes > 0 ? el('span', { class: 'plus', 'aria-hidden': 'true', text: '+' }) : null);
      button.addEventListener('click', () => {
        selected = day.date;
        renderGrid();
        renderDay();
        openDialog(button);
      });
      cells.push(button);
    }
    nodes.mini.replaceChildren(...cells);
    const summary = data.summary;
    const parts = [`기록 ${summary.recordedDays}일`, `휴식 ${summary.restDays}일`];
    if (summary.missedDays > 0) parts.push(`누락 확인 ${summary.missedDays}일`);
    nodes.sideSummary.replaceChildren(...[
      summary.needsReviewDays > 0
        ? el('strong', { class: 'mini-attention', text: `확인할 날 ${summary.needsReviewDays}일` }) : null,
      el('span', { text: parts.join(' · ') })].filter(Boolean));
  }

  // ---- C: the dialog (native <dialog>: modal, Esc, focus kept inside) ----

  function openDialog(from) {
    opener = from ?? document.activeElement;
    if (nodes.dialog.open) return;
    nodes.dialog.classList.remove('closing');
    nodes.dialog.showModal();
    // Start on the selected day when there is one (the learner came for that day).
    const target = nodes.grid.querySelector('.day.selected') ?? nodes.close;
    target.focus();
  }

  function restoreFocus() {
    // A redraw replaces the summary buttons; fall back to the same day or the open button.
    const again = opener?.isConnected ? opener
      : nodes.mini.querySelector(`[data-date="${opener?.dataset?.date}"]`) ?? nodes.open;
    again?.focus();
  }

  function closeDialog() {
    if (!nodes.dialog.open || nodes.dialog.classList.contains('closing')) return;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      nodes.dialog.classList.remove('closing');
      nodes.dialog.close();
      // An error shown in the dialog belongs to that visit; do not greet the next one with it.
      const error = nodes.dialog.querySelector('#calendarError');
      if (error) {
        error.hidden = true;
        error.textContent = '';
      }
      restoreFocus();
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish();
      return;
    }
    nodes.dialog.classList.add('closing');
    nodes.dialog.addEventListener('animationend', finish, { once: true });
    // If the animation never runs (hidden tab, old browser), close anyway.
    setTimeout(finish, 220);
  }

  function renderGrid() {
    nodes.title.textContent = `학습 캘린더 · ${Number(month.slice(0, 4))}년 ${Number(month.slice(5))}월`;
    const cells = ['일', '월', '화', '수', '목', '금', '토'].map(name => el('div', { class: 'dow', text: name }));
    const firstWeekday = new Date(`${month}-01T00:00:00`).getDay();
    for (let index = 0; index < firstWeekday; index += 1) cells.push(el('div', { class: 'day blank', 'aria-hidden': 'true' }));
    for (const day of data.days) {
      const classes = ['day', `state-${day.state}`];
      if (day.makeupMinutes > 0) classes.push('has-makeup');
      if (day.date === selected) classes.push('selected');
      const button = el('button', { type: 'button', class: classes.join(' '), 'data-date': day.date,
        'aria-label': `${koreanDate(day.date)} ${STATE_LABELS[day.state]} ${cellLines(day).join(', ')}` },
      el('span', { class: 'n', text: day.state === 'today' ? `${dayNumber(day.date)} · 오늘` : String(dayNumber(day.date)) }),
      ...cellLines(day).map(line => el('span', { class: 'm', text: line })),
      day.makeupMinutes > 0 ? el('span', { class: 'tag', text: `보완 +${day.makeupMinutes}분` }) : null);
      if (['recorded', 'today'].includes(day.state) && day.assignedMinutes) {
        const width = Math.min(100, Math.round((day.confirmedMinutes / day.assignedMinutes) * 100));
        button.append(el('span', { class: 'bar' }, el('i', { style: `width:${width}%` })));
      }
      button.addEventListener('click', () => select(day.date));
      cells.push(button);
    }
    nodes.grid.replaceChildren(...cells);
  }

  function taskForm(day) {
    const tasks = data.backfillableTasks;
    if (tasks.length === 0) return el('p', { class: 'muted', text: '사후 기록할 수 있는 남은 과업이 없습니다.' });
    const select = el('select', { 'aria-label': '과업' }, ...tasks.map(task =>
      el('option', { value: task.taskId, text: `${task.title} (남은 ${task.remainingMinutes}분)` })));
    const minutes = el('input', { type: 'number', min: '1', step: '1', value: '30', 'aria-label': '공부한 분' });
    const submit = el('button', { type: 'button', text: '사후 기록' });
    submit.addEventListener('click', () => run(() => post('/api/late-progress', {
      date: day.date, taskId: select.value, minutes: Number(minutes.value) })));
    return el('div', { class: 'row' }, el('label', { text: '과업' }, select), el('label', { text: '공부한 분' }, minutes), submit);
  }

  function makeupForm(day, { reviewFirst }) {
    const from = today();
    const dates = Array.from({ length: 14 }, (_, index) => addDays(from, index + 1));
    const date = el('select', { 'aria-label': '보완할 날' }, ...dates.map(value => el('option', { value, text: koreanDate(value) })));
    const minutes = el('input', { type: 'number', min: '1', max: String(data.dailyMinutes), step: '1',
      value: String(Math.min(30, data.dailyMinutes)), 'aria-label': '더할 시간(분)' });
    const submit = el('button', { type: 'button', text: reviewFirst ? '누락 확인 + 보완 계획' : '보완 계획 추가' });
    submit.addEventListener('click', () => run(async () => {
      if (reviewFirst) await post('/api/day-review', { date: day.date, status: 'missed' });
      try {
        return await post('/api/makeup', { forDate: day.date, date: date.value, minutes: Number(minutes.value) });
      } catch (error) {
        // The missed review is already saved; show it so the learner can retry only the make-up part.
        if (reviewFirst) await load().catch(() => {});
        throw error;
      }
    }));
    return el('div', {},
      el('div', { class: 'row' }, el('label', { text: '보완할 날' }, date), el('label', { text: '더할 시간(분)' }, minutes), submit),
      el('p', { class: 'muted', text: `한 날짜에 더할 수 있는 보완 시간은 하루 공부 시간(${data.dailyMinutes}분)까지입니다.` }));
  }

  function choice(number, title, text, ...content) {
    return el('div', { class: 'choice' }, el('h3', {}, el('span', { class: 'step-no', text: String(number) }), title),
      el('p', { class: 'muted', text }), ...content);
  }

  function renderDay() {
    const day = data?.days.find(item => item.date === selected);
    if (!day) {
      nodes.dayTitle.textContent = '날짜를 누르면 그날의 기록이 보입니다';
      nodes.dayBody.replaceChildren();
      return;
    }
    nodes.dayTitle.textContent = `${koreanDate(day.date)} · ${STATE_LABELS[day.state]}`;
    const facts = el('dl', { class: 'day-facts' });
    const fact = (label, value) => facts.append(el('div', {}, el('dt', { text: label }), el('dd', { text: value })));
    if (day.assignedMinutes !== null) fact('배정', `${day.assignedMinutes}분`);
    if (day.confirmedMinutes > 0 || ['recorded', 'today'].includes(day.state)) fact('확인된 공부', `${day.confirmedMinutes}분`);
    if (day.lateMinutes > 0) fact('사후 기록', `${day.lateMinutes}분`);
    if (day.makeupScheduledFor > 0) fact('잡아 둔 보완', `${day.makeupScheduledFor}분`);
    if (day.makeupMinutes > 0) fact('이날 더한 보완 시간', `${day.makeupMinutes}분`);
    if (day.plannedMinutes !== null) fact('예정', `${day.plannedMinutes}분`);
    const body = [facts];
    if (day.state === 'needs_review') {
      body.push(el('p', { text: '이날은 공부 기록이 없습니다. 기록이 없는 날을 공부하지 않은 날로 보지 않으므로, 어떤 날이었는지 직접 확인해 주세요.' }));
      body.push(choice(1, '공부했지만 기록을 못 했어요', '과업과 공부한 분을 적으면 「사후 기록」으로 남고, 그 과업의 남은 분량에서 빠집니다.', taskForm(day)));
      const onlyReview = el('button', { type: 'button', text: '누락 확인만' });
      onlyReview.addEventListener('click', () => run(() => post('/api/day-review', { date: day.date, status: 'missed' })));
      body.push(choice(2, '공부하지 못했어요', '「누락 확인」으로 남기고, 빠진 분량을 채울 날과 시간을 고릅니다. 누락 확인만 하면 빠진 분량은 앞으로의 계획에 나눠 들어갑니다.',
        makeupForm(day, { reviewFirst: true }), onlyReview));
      const rest = el('button', { type: 'button', text: '쉬는 날이었어요' });
      rest.addEventListener('click', () => run(() => post('/api/day-review', { date: day.date, status: 'rest' })));
      body.push(choice(3, '쉬는 날이었어요', '계획한 휴식이었다면 휴식으로 남깁니다.', rest));
    } else if (day.state === 'missed') {
      body.push(choice(1, '보완 계획 더하기', '이 날 빠진 분량을 채울 날과 시간을 고릅니다.', makeupForm(day, { reviewFirst: false })));
    } else if (day.state === 'late') {
      body.push(choice(1, '사후 기록 더하기', '같은 날 공부한 다른 과업이 있으면 더 적을 수 있습니다.', taskForm(day)));
    } else if (day.state === 'today') {
      body.push(el('p', { class: 'muted', text: '오늘 공부는 이 창을 닫고 「실제 공부 시간 기록」에 적어 주세요.' }));
    }
    nodes.dayBody.replaceChildren(...body);
  }

  function renderMonth() {
    const summary = data.summary;
    nodes.monthTitle.textContent = `${Number(month.slice(5))}월 점검 (한 달)`;
    const stat = (value, label) => el('div', { class: 'stat' }, el('b', { text: value }), el('small', { text: label }));
    nodes.monthStats.replaceChildren(
      stat(`${summary.recordedDays}일`, '기록한 날'), stat(`${summary.restDays}일`, '휴식'),
      stat(`${summary.needsReviewDays}일`, '확인 필요'), stat(`${summary.missedDays}일`, '누락 확인'),
      stat(`${summary.lateMinutes}분`, '사후 기록'), stat(`${summary.makeupMinutes}분`, '보완 예정'));
    nodes.needsReview.replaceChildren(...(data.needsReview.length === 0
      ? [el('li', { class: 'muted', text: '확인이 필요한 날이 없습니다.' })]
      : data.needsReview.map(date => {
        const button = el('button', { type: 'button', text: '확인하기' });
        button.addEventListener('click', () => select(date));
        return el('li', { class: 'todo' }, el('span', { text: koreanDate(date) }), button);
      })));
    const lines = [el('div', { class: 'signal ok' }, el('b', { text: `배정 ${summary.assignedMinutes}분 중 ${summary.confirmedMinutes}분을 확인했습니다` }),
      el('span', { text: '사후 기록은 따로 셉니다. 이 숫자는 계획을 따른 양이며 실력이나 합격 가능성을 뜻하지 않습니다.' }))];
    for (const signal of data.signals) lines.push(el('div', { class: 'signal' }, el('span', { text: signal.message })));
    nodes.signals.replaceChildren(...lines);
  }

  async function load() {
    data = await api(`/api/calendar?month=${month}`);
    render();
  }

  function render() {
    // Open on the newest day that still needs the learner's check, so the review starts without a search.
    if (!data.days.some(day => day.date === selected)) selected = data.needsReview[0] ?? null;
    renderGrid();
    renderDay();
    renderMonth();
    renderMini();
  }

  function go(delta) {
    month = shiftMonth(month, delta);
    selected = null;
    run(async () => { await load(); });
  }
  nodes.prev.addEventListener('click', () => go(-1));
  nodes.next.addEventListener('click', () => go(1));
  nodes.sidePrev.addEventListener('click', () => go(-1));
  nodes.sideNext.addEventListener('click', () => go(1));
  nodes.open.addEventListener('click', () => openDialog(nodes.open));
  nodes.close.addEventListener('click', closeDialog);
  nodes.dialog.addEventListener('cancel', event => {
    // Esc: close with the same short fade as the close button.
    event.preventDefault();
    closeDialog();
  });
  nodes.dialog.addEventListener('click', event => {
    // A click on the dimmed area outside the box (the dialog element itself, not its content).
    if (event.target === nodes.dialog) closeDialog();
  });
  // Another tab of the app must not open over a dialog left open on this one.
  window.addEventListener('hashchange', closeDialog);

  return {
    // Status responses from calendar actions carry the calendar; other actions reload the shown month.
    update(calendar) {
      if (calendar && calendar.month === month) {
        data = calendar;
        render();
        return Promise.resolve();
      }
      if (calendar) month = calendar.month;
      return load();
    },
  };
}
