import { createCalendar } from './calendar.js';

// The web version (D022) keeps records in this browser instead of asking the local app's server.
// D024: three tabs (오늘 · 문제 풀기 · 보관함) in plain spoken words; opening the page shows today's work at once.
const browserMode = document.documentElement.dataset.mode === 'browser';
const localApi = browserMode ? await import('./local-api.js') : null;
const sourceModule = browserMode ? await import('./source-view.js') : null;
const solveModule = browserMode ? await import('./solve-view.js') : null;
const notesModule = browserMode ? await import('./notes-view.js') : null;
const wikiModule = browserMode ? await import('./wiki-export-view.js') : null;
const BACKUP_REMINDER_DAYS = 7;

const $ = selector => document.querySelector(selector);
const elements = {
  errorMessage: $('#errorMessage'),
  firstRun: $('#firstRun'),
  firstRunEyebrow: $('#firstRunEyebrow'),
  firstRunTitle: $('#firstRunTitle'),
  setupForm: $('#setupForm'),
  taskRows: $('#taskRows'),
  addTaskRow: $('#addTaskRow'),
  dailyChips: $('#dailyChips'),
  dailyCustom: $('#dailyCustom'),
  dailyMinutesInput: $('#dailyMinutesInput'),
  pdfInput: $('#pdfInput'),
  tasksInput: $('#tasksInput'),
  titleInput: $('#titleInput'),
  setupCancel: $('#setupCancel'),
  setupStatus: $('#setupStatus'),
  todayMain: $('#todayMain'),
  calendarSide: $('#calendarSide'),
  backupNotice: $('#backupNotice'),
  nowLabel: $('#nowLabel'),
  nowTitle: $('#nowTitle'),
  doneButton: $('#doneButton'),
  partButton: $('#partButton'),
  restButton: $('#restButton'),
  unrestButton: $('#unrestButton'),
  partForm: $('#partForm'),
  minutesInput: $('#minutesInput'),
  todayMessage: $('#todayMessage'),
  quitButton: $('#quitButton'),
  allocations: $('#allocations'),
  shortenForm: $('#shortenForm'),
  availableInput: $('#availableInput'),
  weekAllocations: $('#weekAllocations'),
  weekWarning: $('#weekWarning'),
  storageStatus: $('#storageStatus'),
  backupButton: $('#backupButton'),
  restoreButton: $('#restoreButton'),
  restoreInput: $('#restoreInput'),
  clearButton: $('#clearButton'),
  setupAgain: $('#setupAgain'),
  bookStatus: $('#bookStatus'),
  attachForm: $('#attachForm'),
};
let busy = false;
let lastStatus = null;
let chosenTaskId = null;
let editingSetup = false;

function localDateIso(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function api(path, body) {
  if (localApi) return localApi.request(path, body);
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '요청을 처리하지 못했어요.');
  return data;
}

// While the calendar dialog is open the page behind it is covered, so its errors show inside the dialog.
function errorNode() {
  return $('#calendarDialog')?.open ? $('#calendarError') : elements.errorMessage;
}

function showError(error) {
  const node = errorNode();
  node.hidden = false;
  node.textContent = error.message || '요청을 처리하지 못했어요.';
}

function clearError() {
  for (const node of [elements.errorMessage, $('#calendarError')]) {
    if (!node) continue;
    node.hidden = true;
    node.textContent = '';
  }
}

// Runs one action with every control disabled; returns true when it succeeded.
async function run(action) {
  if (busy) return false;
  busy = true;
  const controls = [...document.querySelectorAll('button, input, select, textarea')];
  const disabledBefore = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  let status;
  let ok = true;
  try {
    clearError();
    status = await action();
  } catch (error) {
    ok = false;
    showError(error);
  } finally {
    controls.forEach((control, index) => { control.disabled = disabledBefore[index]; });
    busy = false;
  }
  if (status) {
    try { render(status); } catch (error) { showError(error); }
  }
  return ok;
}

// ---- 처음 설정 (first run and 「새로 정하기」) ----

function taskRow({ title = '', minutes = '', kind = 'new' } = {}) {
  const li = document.createElement('li');
  li.className = 'task-row';
  li.innerHTML = `
    <input class="task-title" type="text" maxlength="120" aria-label="공부할 것" placeholder="예: 4장 교육평가 유형">
    <label class="task-minutes">시간<input type="number" min="1" step="1" aria-label="걸릴 시간(분)" placeholder="60">분</label>
    <select class="task-kind" aria-label="새로 공부 또는 복습"><option value="new">새로 공부</option><option value="review">복습</option></select>
    <button type="button" class="link-button task-remove">빼기</button>`;
  li.querySelector('.task-title').value = title;
  li.querySelector('.task-minutes input').value = minutes;
  li.querySelector('.task-kind').value = kind;
  li.querySelector('.task-remove').addEventListener('click', () => {
    if (elements.taskRows.children.length > 1) li.remove();
    else li.querySelector('.task-title').value = '';
  });
  return li;
}

function resetSetupForm() {
  elements.taskRows.replaceChildren(taskRow(), taskRow({ kind: 'review' }));
  chooseDaily('60');
  elements.pdfInput.value = '';
}

function chooseDaily(minutes) {
  for (const chip of elements.dailyChips.querySelectorAll('.chip')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.minutes === minutes));
  }
  elements.dailyCustom.hidden = minutes !== '';
  if (minutes) elements.dailyMinutesInput.value = minutes;
}

// The form fields the shared rules read (app-core parseSetupFields): one 「제목 | 분 | 종류」 line per row.
function fillSetupFields() {
  const rows = [...elements.taskRows.querySelectorAll('.task-row')]
    .map(row => ({
      title: row.querySelector('.task-title').value.trim().replaceAll('|', '/'),
      minutes: row.querySelector('.task-minutes input').value.trim() || '60',
      kind: row.querySelector('.task-kind').value,
    }))
    .filter(row => row.title);
  if (rows.length === 0) throw new Error('공부할 것을 하나 이상 적어 주세요.');
  elements.tasksInput.value = rows.map(row => `${row.title} | ${row.minutes} | ${row.kind === 'new' ? '새 내용' : '복습'}`).join('\n');
  const file = elements.pdfInput.files[0];
  elements.titleInput.value = file ? file.name.replace(/\.pdf$/i, '').slice(0, 120) : rows[0].title.slice(0, 120);
}

function openSetupAgain() {
  editingSetup = true;
  resetSetupForm();
  elements.firstRunEyebrow.textContent = '공부할 것 바꾸기';
  elements.firstRunTitle.textContent = '새로 무엇을 공부하나요?';
  elements.setupCancel.hidden = false;
  location.hash = '#today';
  if (lastStatus) render(lastStatus);
}

// ---- 오늘 ----

function kindLabel(item) {
  if (item.taskId.startsWith('note:')) return '다시 볼 문제';
  return item.kind === 'new' ? '새로 공부' : '복습';
}

// The web version needs its own setup; the installer app (kept in reserve) may run on a fixed input file or on plans
// made before this screen existed.
function isConfigured(status) {
  if (status.setup?.configured === true) return true;
  return !browserMode && ((status.planSource && status.planSource !== 'synthetic_demo') || Boolean(status.currentPlan));
}

function render(status) {
  lastStatus = status;
  const configured = isConfigured(status);
  const setupShown = !configured || editingSetup;
  elements.firstRun.hidden = !setupShown;
  elements.todayMain.hidden = setupShown;
  elements.calendarSide.hidden = setupShown;
  document.querySelector('#view-today').classList.toggle('setup-mode', setupShown);
  if (!configured && !editingSetup && elements.taskRows.children.length === 0) resetSetupForm();

  const plan = status.currentPlan;
  const allocations = plan?.allocations ?? [];
  const chosen = allocations.find(item => item.taskId === chosenTaskId) ?? allocations[0] ?? null;
  chosenTaskId = chosen?.taskId ?? null;
  const rest = Boolean(plan) && allocations.length === 0 && (plan.deferred ?? []).some(item => item.reason === 'rest_day');
  elements.doneButton.hidden = !chosen;
  elements.partButton.hidden = !chosen;
  elements.restButton.hidden = !chosen;
  elements.unrestButton.hidden = !rest;
  if (!chosen) elements.partForm.hidden = true;
  if (chosen) {
    elements.nowLabel.textContent = `지금 할 것 · ${kindLabel(chosen)}`;
    elements.nowTitle.textContent = `${chosen.title} · ${chosen.minutes}분`;
    elements.minutesInput.max = String(chosen.minutes);
    if (Number(elements.minutesInput.value) > chosen.minutes) elements.minutesInput.value = String(chosen.minutes);
  } else if (rest) {
    elements.nowLabel.textContent = '오늘';
    elements.nowTitle.textContent = '오늘은 쉬는 날이에요.';
  } else if (plan && plan.assignedMinutes > 0) {
    elements.nowLabel.textContent = '오늘';
    elements.nowTitle.textContent = '오늘 할 것을 다 했어요.';
  } else if (plan) {
    elements.nowLabel.textContent = '오늘';
    elements.nowTitle.textContent = '오늘 할 것이 없어요. 「보관함 → 공부할 것 바꾸기」에서 새로 정할 수 있어요.';
  } else {
    elements.nowLabel.textContent = '오늘';
    elements.nowTitle.textContent = '오늘 할 것을 만들고 있어요.';
  }

  elements.allocations.replaceChildren(...(allocations.length === 0
    ? [Object.assign(document.createElement('li'), { className: 'muted', textContent: '남은 것이 없어요.' })]
    : allocations.map(item => {
      const li = document.createElement('li');
      li.className = 'today-item';
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'task-pick';
      pick.setAttribute('aria-pressed', String(item.taskId === chosenTaskId));
      pick.innerHTML = '<span class="task-name"></span><span class="task-meta"></span>';
      pick.querySelector('.task-name').textContent = item.title;
      pick.querySelector('.task-meta').textContent = `${item.minutes}분 · ${kindLabel(item)}`;
      pick.addEventListener('click', () => {
        chosenTaskId = item.taskId;
        elements.todayMessage.textContent = '';
        render(lastStatus);
      });
      const skip = document.createElement('button');
      skip.type = 'button';
      skip.className = 'link-button';
      skip.textContent = '건너뛰기';
      skip.setAttribute('aria-label', `${item.title} 건너뛰기`);
      skip.addEventListener('click', async () => {
        if (await run(() => api('/api/skip', { taskId: item.taskId }))) {
          elements.todayMessage.textContent = `「${item.title}」은 건너뛰었어요. 뒤 계획으로 넘어가요.`;
        }
      });
      li.append(pick, skip);
      return li;
    })));

  renderWeek(status.weeklyForecast, status.weeklyForecastError);
  calendar.update(status.calendar).catch(showError);
  if (localApi) {
    renderDataPanel().catch(showError);
    if (currentView() === 'solve') solveView.update().catch(showError);
    if (currentView() === 'keep') updateKeep().catch(showError);
  }
}

function renderWeek(week, error) {
  if (!week) {
    elements.weekAllocations.replaceChildren();
    elements.weekWarning.textContent = error ?? '';
    return;
  }
  elements.weekWarning.textContent = '';
  elements.weekAllocations.replaceChildren(...week.tentativeAllocations.slice(0, 8).map(item => {
    const li = document.createElement('li');
    const date = new Date(`${item.date}T00:00:00`);
    li.textContent = `${date.getMonth() + 1}월 ${date.getDate()}일 · ${item.title} ${item.minutes}분`;
    return li;
  }));
}

// Opening the page makes today's plan when there is none for today yet (D024: no 「오늘 시작」 step).
async function refresh() {
  let status = await api('/api/status');
  const today = localDateIso();
  if (isConfigured(status) && (!status.currentPlan || status.currentPlan.date !== today)) {
    try {
      status = await api('/api/start', { date: today });
    } catch (error) {
      showError(error);
    }
  }
  render(status);
}

// ---- 보관함 ----

function daysSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

async function renderDataPanel() {
  const info = await localApi.storageInfo();
  const lines = [info.lastBackupAt
    ? `마지막 보관: ${localDateIso(new Date(info.lastBackupAt))}.`
    : '아직 보관 파일을 저장하지 않았어요.'];
  if (info.persisted === false) lines.push('이 브라우저는 오래 쓰지 않은 사이트의 기록을 지울 수 있어요. 가끔 보관해 주세요.');
  elements.storageStatus.textContent = lines.join(' ');
  let notice = '';
  if (info.hasRecords && !info.lastBackupAt) notice = '기록을 파일로 한 번 보관해 두세요.';
  else if (info.hasRecords && daysSince(info.lastBackupAt) >= BACKUP_REMINDER_DAYS) {
    notice = `보관한 지 ${BACKUP_REMINDER_DAYS}일이 지났어요. 새로 보관해 두세요.`;
  }
  elements.backupNotice.hidden = notice === '';
  if (notice) {
    const link = Object.assign(document.createElement('a'), { href: '#keep', textContent: '보관함에서 저장하기' });
    elements.backupNotice.replaceChildren(`${notice} `, link);
  }
}

function renderBook(setup) {
  const source = setup?.source ?? null;
  if (!source) {
    elements.bookStatus.textContent = '아직 넣은 교재가 없어요. PDF를 넣으면 「문제 풀기」에서 내 답을 교재와 맞춰 볼 수 있어요.';
    $('#attachButton').textContent = '교재 넣기';
    return;
  }
  const pages = source.pages ?? [];
  const textless = pages.filter(page => page.hasText === false).length;
  elements.bookStatus.textContent = `${source.originalName} · ${pages.length}쪽을 읽었어요`
    + (textless > 0 ? ` (글자가 없는 쪽 ${textless}쪽은 그림이나 스캔이라 글자를 못 읽었어요)` : '') + '.';
  $('#attachButton').textContent = '다른 교재로 바꾸기';
}

// 「AI 허락」: consents given in 문제 풀기, newest first, each can be taken back (PRD 4).
async function renderAiConsents() {
  const list = $('#aiConsentList');
  const consents = [...await localApi.aiConsents()].reverse();
  if (consents.length === 0) {
    list.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: '아직 남긴 허락이 없어요.' }));
    return;
  }
  list.replaceChildren(...consents.map(consent => {
    const item = document.createElement('li');
    item.dataset.consentId = consent.consentId;
    const text = document.createElement('span');
    text.textContent = `${consent.provider} · 교재 원문 ${consent.sourceRights === 'confirmed' ? '함께 보냄' : '빼고 보냄'}`
      + ` · ${consent.grantedAt.slice(0, 10)}` + (consent.revokedAt ? ` · 거둠 ${consent.revokedAt.slice(0, 10)}` : '');
    item.append(text);
    if (!consent.revokedAt) {
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'link-button danger-link';
      revoke.textContent = '거두기';
      revoke.addEventListener('click', () => {
        if (!window.confirm('이 허락을 거둘까요? 이미 AI에 붙여 넣은 내용은 되돌릴 수 없어요.')) return;
        revoke.disabled = true;
        localApi.revokeAiConsent(consent.consentId).then(renderAiConsents).catch(showError);
      });
      item.append(' ', revoke);
    }
    return item;
  }));
}

// fresh: opening the tab starts clean; a redraw after an action keeps the notes that action left.
async function updateKeep({ fresh = false } = {}) {
  // Marks when every list of the tab has been drawn (tests wait for it before typing).
  viewNodes.keep.removeAttribute('data-loaded');
  await Promise.all([
    notesView.update({ fresh }),
    solveView.renderSolved($('#solvedList')),
    sourceView.update(),
    wikiView.update(),
    renderAiConsents(),
    renderDataPanel(),
  ]);
  renderBook(lastStatus?.setup);
  viewNodes.keep.setAttribute('data-loaded', '');
}

function download(fileName, text) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

// ---- views: the address hash picks the tab, so back/forward and bookmarks work ----

const VIEWS = ['today', 'solve', 'keep'];
// Addresses from v0.9 (bookmarks, the old guide) still land on the tab that now holds that screen.
const OLD_VIEWS = { plan: 'today', study: 'solve', source: 'keep', notes: 'keep', data: 'keep' };
const viewNodes = { today: $('#view-today'), solve: $('#view-solve'), keep: $('#view-keep') };
const calendar = createCalendar({ api, run, today: localDateIso });
const sourceView = sourceModule ? sourceModule.createSourceView({ load: () => localApi.sourceView() }) : null;
const solveView = solveModule ? solveModule.createSolveView({ api: localApi, onChange: () => refresh() }) : null;
const notesView = notesModule ? notesModule.createNotesView({
  api: localApi,
  openInStudy: id => {
    solveView.open(id);
    location.hash = '#solve';
  },
  afterChange: () => refresh(),
}) : null;
const wikiView = wikiModule ? wikiModule.createWikiExportView({ api: localApi }) : null;

function currentView() {
  const name = location.hash.slice(1);
  if (OLD_VIEWS[name]) return OLD_VIEWS[name];
  return VIEWS.includes(name) ? name : 'today';
}

function showView() {
  const name = currentView();
  if (OLD_VIEWS[location.hash.slice(1)]) history.replaceState(null, '', `#${name}`);
  for (const [view, node] of Object.entries(viewNodes)) node.hidden = view !== name;
  for (const link of document.querySelectorAll('#appTabs a')) {
    link.setAttribute('aria-current', link.dataset.view === name ? 'page' : 'false');
  }
  if (name === 'today') refresh().catch(showError);
  if (name === 'solve') solveView.update().catch(showError);
  if (name === 'keep') updateKeep({ fresh: true }).catch(showError);
}

// ---- events ----

elements.dailyChips.addEventListener('click', event => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  chooseDaily(chip.dataset.minutes);
  if (!chip.dataset.minutes) elements.dailyMinutesInput.focus();
});
elements.addTaskRow.addEventListener('click', () => {
  if (elements.taskRows.children.length >= 30) return;
  const row = taskRow();
  elements.taskRows.append(row);
  row.querySelector('.task-title').focus();
});
elements.setupCancel.addEventListener('click', () => {
  editingSetup = false;
  elements.setupCancel.hidden = true;
  if (lastStatus) render(lastStatus);
});
elements.setupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    fillSetupFields();
  } catch (error) {
    showError(error);
    return;
  }
  if (editingSetup && !window.confirm('계획을 처음부터 다시 만들어요. 지금까지의 공부 시간 기록은 이 브라우저 안에 따로 보관돼요. 계속할까요?')) return;
  // Collect the fields before run() disables every control: FormData skips disabled fields,
  // so building it inside run() sent an empty upload from real browsers.
  const body = new FormData(elements.setupForm);
  elements.setupStatus.textContent = elements.pdfInput.files[0] ? '교재를 읽고 있어요. 쪽이 많으면 조금 걸려요.' : '';
  const ok = await run(async () => {
    const status = localApi ? await localApi.setup(body) : await (async () => {
      const response = await fetch('/api/setup', { method: 'POST', body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? '설정을 저장하지 못했어요.');
      return data;
    })();
    editingSetup = false;
    elements.setupCancel.hidden = true;
    elements.firstRunEyebrow.textContent = '처음 한 번만';
    elements.firstRunTitle.textContent = '무엇을 공부하나요?';
    return api('/api/start', { date: localDateIso() }).catch(() => status);
  });
  elements.setupStatus.textContent = ok ? '' : '기록은 이 브라우저에만 저장돼요. 다른 브라우저나 시크릿 창에서는 보이지 않아요.';
});

function chosenAllocation() {
  return (lastStatus?.currentPlan?.allocations ?? []).find(item => item.taskId === chosenTaskId) ?? null;
}

async function record(item, minutes) {
  const ok = await run(() => api('/api/progress', { requestId: crypto.randomUUID(), taskId: item.taskId, completedMinutes: minutes }));
  if (!ok) return;
  elements.partForm.hidden = true;
  const next = chosenAllocation();
  elements.todayMessage.textContent = `${minutes}분 적었어요.` + (next ? ` 다음은 「${next.title}」예요.` : '');
}

elements.doneButton.addEventListener('click', () => {
  const item = chosenAllocation();
  if (item) record(item, item.minutes);
});
elements.partButton.addEventListener('click', () => {
  elements.partForm.hidden = false;
  elements.minutesInput.focus();
});
elements.partForm.addEventListener('submit', event => {
  event.preventDefault();
  const item = chosenAllocation();
  if (item) record(item, Number(elements.minutesInput.value));
});
elements.restButton.addEventListener('click', async () => {
  if (await run(() => api('/api/rest', { date: localDateIso() }))) {
    elements.todayMessage.textContent = '오늘은 쉬는 날로 적었어요. 남은 것은 뒤로 넘어가요.';
  }
});
elements.unrestButton.addEventListener('click', async () => {
  if (await run(() => api('/api/start', { date: localDateIso() }))) elements.todayMessage.textContent = '';
});
elements.shortenForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (await run(() => api('/api/shorten', { date: localDateIso(), availableMinutes: Number(elements.availableInput.value) }))) {
    elements.todayMessage.textContent = '남은 시간에 맞춰 오늘 할 것을 줄였어요.';
  }
});
elements.quitButton.addEventListener('click', () => {
  run(async () => {
    const data = await api('/api/quit', {});
    elements.nowTitle.textContent = data.message;
    elements.todayMessage.textContent = '창을 닫아 주세요.';
    return null;
  });
});

if (localApi) {
  document.querySelector('#appTabs').hidden = false;
  elements.setupAgain.addEventListener('click', openSetupAgain);
  elements.attachForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!$('#attachInput').files[0]) {
      showError(new Error('PDF 파일을 골라 주세요.'));
      return;
    }
    if (lastStatus?.setup?.source && !window.confirm('교재를 바꿀까요? 푼 문제에 저장된 교재 글은 그대로 남아요.')) return;
    const body = new FormData(elements.attachForm);
    elements.bookStatus.textContent = '교재를 읽고 있어요. 쪽이 많으면 조금 걸려요.';
    await run(() => localApi.attachSource(body));
    elements.attachForm.reset();
    await updateKeep().catch(showError);
  });
  elements.backupButton.addEventListener('click', () => {
    run(async () => {
      const backup = await localApi.exportBackup();
      download(backup.fileName, backup.text);
      await renderDataPanel();
      return null;
    });
  });
  elements.restoreButton.addEventListener('click', () => elements.restoreInput.click());
  elements.restoreInput.addEventListener('change', () => {
    const file = elements.restoreInput.files[0];
    elements.restoreInput.value = '';
    if (!file) return;
    if (!window.confirm('지금 이 브라우저의 기록을 보관 파일의 기록으로 바꿔요. 계속할까요?')) return;
    run(async () => localApi.importBackup(await file.text()));
  });
  elements.clearButton.addEventListener('click', () => {
    if (!window.confirm('이 브라우저의 기록을 모두 지워요. 보관 파일이 없으면 되돌릴 수 없어요. 지울까요?')) return;
    // Nothing is left to keep: start again from the first-run question.
    run(() => localApi.clearAll()).then(ok => { if (ok) location.hash = '#today'; });
  });
  // Another tab of this app changed the records; show them here too.
  localApi.onChange(() => { refresh().catch(showError); });
  window.addEventListener('hashchange', showView);
  showView();
} else {
  elements.quitButton.hidden = false;
  refresh().catch(showError);
}
