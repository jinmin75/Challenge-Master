// 개인 Wiki로 내보내기 (D023 A-5): Moa-format Markdown for the learner's own Wiki, written straight into the Wiki
// folder (Chrome·Edge: File System Access) or downloaded as a zip (every browser). Before writing, the export is
// format-checked; afterwards the view lists where each file went (docs/moa-lessons.md #9).
import { createZip } from './src/zip-core.mjs';

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value);
  }
  node.append(...children.filter(child => child !== null && child !== undefined && child !== false));
  return node;
}

// The chosen folder must be the Wiki's top folder (Moa requires wiki/ and raw/ there); never create a Wiki elsewhere.
export async function checkWikiRoot(root) {
  for (const name of ['wiki', 'raw']) {
    try {
      await root.getDirectoryHandle(name);
      return null;
    } catch { /* not there */ }
  }
  return `고른 폴더(${root.name})에 wiki나 raw 폴더가 없습니다. 개인 Wiki의 맨 위 폴더를 고르세요.`;
}

export async function writeFilesToDirectory(root, files) {
  const written = [];
  for (const file of files) {
    const parts = file.path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
    const handle = await dir.getFileHandle(parts.at(-1), { create: true });
    const writable = await handle.createWritable();
    await writable.write(file.content);
    await writable.close();
    written.push(file.path);
  }
  return written;
}

function download(fileName, bytes) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

export function createWikiExportView({ api }) {
  const root = document.querySelector('#wikiPanel');
  const summaryNode = root.querySelector('#wikiSummary');
  const checkNode = root.querySelector('#wikiCheck');
  const actionsNode = root.querySelector('#wikiActions');
  const filesNode = root.querySelector('#wikiFiles');
  const resultNode = root.querySelector('#wikiResult');
  const folderSupported = typeof window.showDirectoryPicker === 'function';
  let preview = null;
  let result = null;

  function guarded(label, blocker, onClick, kind = '') {
    const button = el('button', { type: 'button', class: kind, 'data-action': label, disabled: Boolean(blocker) });
    button.textContent = label;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        result = await onClick();
      } catch (error) {
        if (error?.name === 'AbortError') result = null; // the learner closed the folder picker
        else result = { kind: 'error', text: error.message };
      }
      await update();
    });
    return el('div', { class: 'guarded' }, button,
      el('span', { class: 'blocked-reason', 'data-reason': label, text: blocker ? `잠김: ${blocker}` : '' }));
  }

  function render() {
    const { counts, entries, files, problems, lastExport } = preview;
    const logCount = entries.reduce((sum, entry) => sum + entry.wikiPaths.length - 1, 0);
    summaryNode.textContent = entries.length === 0
      ? '내보낼 기록이 없습니다. 학습실에서 「원문과 대조 시작」까지 한 기록부터 내보냅니다.'
      : `내보낼 기록 ${entries.length}개(새로 ${counts.new} · 바뀜 ${counts.changed} · 그대로 ${counts.same}) · 학습로그 ${logCount}개 · 파일 ${files.length}개${lastExport ? ` · 마지막 내보내기 ${lastExport.at.slice(0, 10)}` : ''}`;
    checkNode.replaceChildren(...(entries.length === 0 ? [] : problems.length === 0
      ? [el('span', { class: 'check-ok', text: '형식 검사 통과: 모든 노트에 필요한 머리말이 있고 경로가 올바릅니다.' })]
      : [el('span', { class: 'blocked-reason', text: '형식 검사에서 문제가 있어 내보낼 수 없습니다:' }),
        el('ul', {}, ...problems.map(problem => el('li', { text: problem })))]));
    const blocker = entries.length === 0 ? '내보낼 기록이 없습니다.'
      : problems.length > 0 ? '형식 검사 문제를 먼저 해결해야 합니다.' : null;
    actionsNode.replaceChildren(
      guarded('내 Wiki 폴더에 바로 쓰기', blocker ?? (folderSupported ? null
        : '이 브라우저에서는 폴더에 바로 쓸 수 없습니다(Chrome·Edge에서 가능). 아래 묶음 파일을 받으세요.'), async () => {
        const folder = await window.showDirectoryPicker({ id: 'challenge-master-wiki', mode: 'readwrite' });
        const wrong = await checkWikiRoot(folder);
        if (wrong) throw new Error(wrong);
        const written = await writeFilesToDirectory(folder, files);
        await api.markWikiExported(entries, 'folder');
        return { kind: 'folder', text: `「${folder.name}」 폴더에 파일 ${written.length}개를 썼습니다.`, paths: written };
      }),
      guarded('묶음 파일(zip) 받기', blocker, async () => {
        download(`challenge-master-wiki-${new Date().toISOString().slice(0, 10)}.zip`, createZip(files));
        await api.markWikiExported(entries, 'zip');
        return { kind: 'zip', text: '묶음 파일을 받았습니다. 개인 Wiki의 맨 위 폴더(wiki와 raw 폴더가 있는 곳)에 압축을 풀면 아래 위치에 들어갑니다.',
          paths: files.map(file => file.path) };
      }, 'secondary'));
    filesNode.replaceChildren(...(files.length === 0 ? [] : [el('details', {},
      el('summary', { text: `들어갈 파일 ${files.length}개 보기` }),
      el('ul', { class: 'file-list' }, ...files.map(file => el('li', { text: file.path }))))]));
    resultNode.replaceChildren(...(!result ? [] : [
      el('p', { class: `step-note ${result.kind === 'error' ? 'error' : ''}`, role: result.kind === 'error' ? 'alert' : 'status',
        'data-note': 'wiki', text: result.text }),
      result.paths ? el('ul', { class: 'file-list' }, ...result.paths.filter(path => path.startsWith('wiki/'))
        .map(path => el('li', { text: path }))) : null]));
  }

  async function update() {
    preview = await api.wikiExportPreview();
    render();
  }

  return { update };
}
