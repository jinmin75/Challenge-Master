import { createCalendar } from './calendar.js';

// The web version (D022) keeps records in this browser instead of asking the local app's server.
const browserMode = document.documentElement.dataset.mode === 'browser';
const localApi = browserMode ? await import('./local-api.js') : null;
const sourceModule = browserMode ? await import('./source-view.js') : null;
const studyModule = browserMode ? await import('./study-view.js') : null;
const BACKUP_REMINDER_DAYS = 7;

const elements = {
  recommendation: document.querySelector('#recommendation'),
  contract: document.querySelector('#contract'),
  sourceLabel: document.querySelector('#sourceLabel'),
  errorMessage: document.querySelector('#errorMessage'),
  startButton: document.querySelector('#startButton'),
  quitButton: document.querySelector('#quitButton'),
  setupPanel: document.querySelector('#setupPanel'),
  setupForm: document.querySelector('#setupForm'),
  setupStatus: document.querySelector('#setupStatus'),
  extractionPanel: document.querySelector('#extractionPanel'),
  extractionPages: document.querySelector('#extractionPages'),
  progressForm: document.querySelector('#progressForm'),
  shortenForm: document.querySelector('#shortenForm'),
  restButton: document.querySelector('#restButton'),
  skipButton: document.querySelector('#skipButton'),
  taskSelect: document.querySelector('#taskSelect'),
  minutesInput: document.querySelector('#minutesInput'),
  availableInput: document.querySelector('#availableInput'),
  planVersion: document.querySelector('#planVersion'),
  assignedMinutes: document.querySelector('#assignedMinutes'),
  confirmedMinutes: document.querySelector('#confirmedMinutes'),
  coverage: document.querySelector('#coverage'),
  allocations: document.querySelector('#allocations'),
  warning: document.querySelector('#warning'),
  weekObserved: document.querySelector('#weekObserved'),
  weekTentative: document.querySelector('#weekTentative'),
  weekDeferred: document.querySelector('#weekDeferred'),
  weekAllocations: document.querySelector('#weekAllocations'),
  weekWarning: document.querySelector('#weekWarning'),
  backupNotice: document.querySelector('#backupNotice'),
  dataPanel: document.querySelector('#dataPanel'),
  storageStatus: document.querySelector('#storageStatus'),
  backupButton: document.querySelector('#backupButton'),
  restoreButton: document.querySelector('#restoreButton'),
  restoreInput: document.querySelector('#restoreInput'),
  clearButton: document.querySelector('#clearButton'),
};
let visibleAllocations = [];
let busy = false;

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
  if (!response.ok) throw new Error(data.error ?? '요청 실패');
  return data;
}

function showError(error) {
  elements.errorMessage.hidden = false;
  elements.errorMessage.textContent = error.message || '요청을 처리하지 못했습니다.';
}

function clearError() {
  elements.errorMessage.hidden = true;
  elements.errorMessage.textContent = '';
}

async function run(action) {
  if (busy) return;
  busy = true;
  const controls = [...document.querySelectorAll('button, input, select, textarea')];
  const disabledBefore = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  let status;
  try {
    clearError();
    status = await action();
  } catch (error) {
    showError(error);
  } finally {
    controls.forEach((control, index) => { control.disabled = disabledBefore[index]; });
    busy = false;
  }
  if (status) {
    try { render(status); } catch (error) { showError(error); }
  }
}

function optionFor(item) {
  const option = document.createElement('option');
  option.value = item.taskId;
  option.textContent = `${item.title} (${item.minutes}분)`;
  return option;
}

function render(status) {
  const plan = status.currentPlan;
  elements.recommendation.textContent = status.recommendedAction.label;
  elements.contract.textContent = status.progressContract;
  elements.sourceLabel.textContent = sourceText(status);
  elements.setupPanel.classList.toggle('configured', status.setup?.configured === true);
  elements.setupStatus.textContent = status.setup?.message
    ?? '새 자료를 등록하면 현재 계획 기록은 별도 파일로 보존하고, 새 계획은 빈 기록에서 시작합니다.';
  renderExtraction(status.setup);
  elements.planVersion.textContent = plan?.planVersion ?? '-';
  elements.startButton.textContent = plan ? '남은 과업 다시 배정' : '오늘 시작';
  elements.assignedMinutes.textContent = plan ? `${plan.assignedMinutes}분` : '-';
  elements.confirmedMinutes.textContent = `${status.confirmedProgressMinutes}분`;
  elements.coverage.textContent = ({ infeasible: '현재 시간으로 전체 완료 어려움', within_time: '현재 범위 유지',
    unknown: '전체 범위 미확인' })[plan?.goalCoverageStatus] ?? '-';
  elements.warning.textContent = plan?.warning ?? '';
  renderWeek(status.weeklyForecast, status.weeklyForecastError);
  calendar.update(status.calendar).catch(showError);
  if (localApi) {
    renderDataPanel().catch(showError);
    if (currentView() === 'source') sourceView.update().catch(showError);
    if (currentView() === 'study') studyView.update().catch(showError);
  }

  visibleAllocations = plan?.allocations ?? [];
  elements.taskSelect.replaceChildren(...visibleAllocations.map(optionFor));
  elements.progressForm.querySelector('button').disabled = visibleAllocations.length === 0;
  elements.skipButton.disabled = visibleAllocations.length === 0;
  elements.allocations.replaceChildren(...(plan?.allocations ?? []).map(item => {
    const li = document.createElement('li');
    li.textContent = `${item.title}: ${item.minutes}분 (${item.kind === 'new' ? '새 범위' : '확인·교정'})`;
    return li;
  }));

  syncMinutesLimit();
}

function sourceText(status) {
  if (status.setup?.configured) return `로컬 PDF: ${status.setup.source.originalName}`;
  if (status.planSource && status.planSource !== 'synthetic_demo') return `로컬 입력: ${status.planSource}`;
  return '합성 데모 입력입니다. 먼저 PDF와 공부 범위를 등록해 주세요.';
}

function renderExtraction(setup) {
  const pages = setup?.source?.pages ?? [];
  elements.extractionPanel.hidden = pages.length === 0;
  elements.extractionPages.replaceChildren(...pages.map(page => {
    const li = document.createElement('li');
    const textless = page.status !== 'failed' && page.hasText === false;
    const statusLabel = page.status === 'failed' ? '추출 실패'
      : textless ? '글자 없음(스캔 또는 빈 쪽)' : '추출 초안';
    li.textContent = `${page.pdfPageIndex}쪽 · ${statusLabel} · 원본 대조 필요`;
    li.className = textless ? 'textless' : page.status;
    return li;
  }));
}

function syncMinutesLimit() {
  const selected = visibleAllocations.find(item => item.taskId === elements.taskSelect.value);
  if (!selected) return;
  elements.minutesInput.max = String(selected.minutes);
  elements.minutesInput.value = String(Math.min(Number(elements.minutesInput.value) || selected.minutes, selected.minutes));
}

function renderWeek(week, error) {
  if (!week) {
    elements.weekObserved.textContent = '-';
    elements.weekTentative.textContent = '-';
    elements.weekDeferred.textContent = '-';
    elements.weekAllocations.replaceChildren();
    elements.weekWarning.textContent = error ?? '주간 예측이 없습니다.';
    return;
  }
  const deferredMinutes = week.deferredScope.reduce((sum, item) => sum + item.minutes, 0);
  elements.weekObserved.textContent = `확인 ${week.totalObservedCompletedMinutes}분`;
  elements.weekTentative.textContent = `예정 ${week.totalTentativeMinutes}분`;
  elements.weekDeferred.textContent = `미배정 ${deferredMinutes}분`;
  elements.weekWarning.textContent = week.warning ?? '';
  elements.weekAllocations.replaceChildren(...week.tentativeAllocations.slice(0, 8).map(item => {
    const li = document.createElement('li');
    li.textContent = `${item.date} · ${item.title}: ${item.minutes}분 예정`;
    return li;
  }));
}

async function refresh() {
  render(await api('/api/status'));
}

elements.startButton.addEventListener('click', () => {
  run(() => api('/api/start', { date: localDateIso() }));
});
elements.quitButton.addEventListener('click', () => {
  run(async () => {
    const data = await api('/api/quit', {});
    elements.recommendation.textContent = data.message;
    elements.contract.textContent = '창을 닫아 주세요.';
    return null;
  });
});
elements.taskSelect.addEventListener('change', syncMinutesLimit);

elements.setupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  // Collect the fields before run() disables every control: FormData skips disabled fields,
  // so building it inside run() sent an empty upload from real browsers.
  const body = new FormData(elements.setupForm);
  run(async () => {
    if (localApi) return localApi.setup(body);
    const response = await fetch('/api/setup', {
      method: 'POST',
      body,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? '설정을 저장하지 못했습니다.');
    return data;
  });
});

elements.progressForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  run(() => api('/api/progress', {
    requestId: crypto.randomUUID(),
    taskId: elements.taskSelect.value,
    completedMinutes: Number(elements.minutesInput.value),
  }));
});

elements.shortenForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  run(() => api('/api/shorten', {
    date: localDateIso(),
    availableMinutes: Number(elements.availableInput.value),
  }));
});

elements.restButton.addEventListener('click', () => {
  run(() => api('/api/rest', { date: localDateIso() }));
});

elements.skipButton.addEventListener('click', () => {
  run(() => api('/api/skip', { taskId: elements.taskSelect.value }));
});

const calendar = createCalendar({ api, run, today: localDateIso });

function daysSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

async function renderDataPanel() {
  const info = await localApi.storageInfo();
  const lines = [info.lastBackupAt
    ? `마지막 백업 파일 저장: ${localDateIso(new Date(info.lastBackupAt))}.`
    : '아직 백업 파일을 저장하지 않았습니다.'];
  if (info.persisted === false) lines.push('이 브라우저는 오래 쓰지 않은 사이트의 기록을 정리할 수 있습니다. 백업 파일을 자주 저장해 주세요.');
  elements.storageStatus.textContent = lines.join(' ');
  let notice = '';
  if (info.hasRecords && !info.lastBackupAt) {
    notice = '아직 백업 파일을 저장하지 않았습니다. 「내 기록」 탭에서 한 번 저장해 두세요.';
  } else if (info.hasRecords && daysSince(info.lastBackupAt) >= BACKUP_REMINDER_DAYS) {
    notice = `마지막 백업 파일을 저장한 지 ${BACKUP_REMINDER_DAYS}일이 지났습니다. 「내 기록」 탭에서 새로 저장해 두세요.`;
  }
  elements.backupNotice.hidden = notice === '';
  elements.backupNotice.textContent = notice;
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

// Web version screens (D023): tabs switch views by the address hash, so back/forward and bookmarks work.
const VIEWS = ['plan', 'source', 'study', 'data'];
const viewNodes = { plan: document.querySelector('#view-plan'), source: document.querySelector('#view-source'),
  study: document.querySelector('#view-study'), data: elements.dataPanel };
const sourceView = sourceModule ? sourceModule.createSourceView({ load: () => localApi.sourceView() }) : null;
const studyView = studyModule ? studyModule.createStudyView({ api: localApi }) : null;

function currentView() {
  const name = location.hash.slice(1);
  return VIEWS.includes(name) ? name : 'plan';
}

function showView() {
  const name = currentView();
  for (const [view, node] of Object.entries(viewNodes)) node.hidden = view !== name;
  for (const link of document.querySelectorAll('#appTabs a')) {
    link.setAttribute('aria-current', link.dataset.view === name ? 'page' : 'false');
  }
  if (name === 'source') sourceView.update().catch(showError);
  if (name === 'study') studyView.update().catch(showError);
}

if (localApi) {
  elements.quitButton.hidden = true;
  document.querySelector('#appTabs').hidden = false;
  showView();
  window.addEventListener('hashchange', showView);
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
    if (!window.confirm('지금 이 브라우저의 기록을 백업 파일의 기록으로 바꿉니다. 계속할까요?')) return;
    run(async () => localApi.importBackup(await file.text()));
  });
  elements.clearButton.addEventListener('click', () => {
    if (!window.confirm('이 브라우저에 저장된 자료 설정과 공부 기록을 모두 지웁니다. 백업 파일이 없으면 되돌릴 수 없습니다. 지울까요?')) return;
    run(() => localApi.clearAll());
  });
  // Another tab of this app changed the records; show them here too.
  localApi.onChange(() => { refresh().catch(showError); });
}

refresh().catch(error => {
  showError(error);
});
