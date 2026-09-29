// 교재 보기 (D023 A-1): read the registered PDF's extracted pages and find words in them.
// Text is placed with textContent only; extracted PDF text never becomes markup.
import { matchRanges, searchPages } from './src/study-core.mjs';

const STATE_LABELS = {
  draft: '글자 읽음',
  textless: '글자 없음(그림이나 스캔)',
  failed: '못 읽음',
  missing: '읽은 결과 없음',
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

function pageName(page) {
  return page.printedPageLabel ? `PDF ${page.pdfPageIndex}쪽 (책 ${page.printedPageLabel}쪽)` : `PDF ${page.pdfPageIndex}쪽`;
}

// The page text with every match wrapped in <mark>, built from text nodes.
function highlighted(text, query) {
  const ranges = matchRanges(text, query);
  if (ranges.length === 0) return [document.createTextNode(text)];
  const parts = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(document.createTextNode(text.slice(at, start)));
    parts.push(el('mark', { text: text.slice(start, end) }));
    at = end;
  }
  if (at < text.length) parts.push(document.createTextNode(text.slice(at)));
  return parts;
}

export function createSourceView({ load }) {
  const nodes = {
    title: document.querySelector('#sourceTitle'),
    meta: document.querySelector('#sourceMeta'),
    search: document.querySelector('#sourceSearch'),
    searchResult: document.querySelector('#sourceSearchResult'),
    body: document.querySelector('#sourceBody'),
    list: document.querySelector('#sourcePageList'),
    page: document.querySelector('#sourcePage'),
    empty: document.querySelector('#sourceEmpty'),
  };
  let source = null;
  let selected = null;
  let query = '';

  function renderList(matches) {
    const counts = new Map(matches.map(match => [match.pdfPageIndex, match.count]));
    nodes.list.replaceChildren(...source.pages.map(page => {
      const count = counts.get(page.pdfPageIndex) ?? 0;
      const button = el('button', { type: 'button', class: `page-item state-${page.state}`,
        'aria-current': page.pdfPageIndex === selected ? 'true' : 'false' },
      el('span', { class: 'page-number', text: `${page.pdfPageIndex}쪽` }),
      el('span', { class: 'page-state', text: STATE_LABELS[page.state] }),
      count > 0 ? el('span', { class: 'page-hits', text: `${count}곳` }) : null);
      button.addEventListener('click', () => {
        selected = page.pdfPageIndex;
        render();
        nodes.page.focus();
      });
      return el('li', {}, button);
    }));
  }

  function renderPage() {
    const page = source.pages.find(item => item.pdfPageIndex === selected);
    const parts = [el('h3', { text: pageName(page) }), el('p', { class: `page-badge state-${page.state}`, text: STATE_LABELS[page.state] })];
    if (page.state === 'draft') {
      parts.push(el('p', { class: 'muted', text: '자동으로 읽은 글자예요. 표·수식·그림과 줄 순서는 PDF와 다를 수 있어요.' }));
      parts.push(el('pre', { class: 'page-text' }, ...highlighted(page.text, query)));
    } else if (page.state === 'textless') {
      parts.push(el('p', { text: '이 쪽은 글자를 못 읽었어요. 그림이나 스캔한 쪽이에요. PDF에서 직접 봐 주세요.' }));
    } else {
      parts.push(el('p', { text: '이 쪽을 읽지 못했어요. PDF에서 직접 봐 주세요.' }));
    }
    // The general "compare with the original" note is already said above; keep page-specific ones (images, errors).
    const issues = page.issues.filter(issue => !issue.startsWith('원본 PDF와 텍스트'));
    if (issues.length > 0) {
      parts.push(el('ul', { class: 'page-issues' }, ...issues.map(issue => el('li', { text: issue }))));
    }
    nodes.page.replaceChildren(...parts);
  }

  function render() {
    const hasSource = Boolean(source && source.pages.length > 0);
    nodes.empty.hidden = hasSource;
    nodes.body.hidden = !hasSource;
    nodes.search.disabled = !hasSource;
    if (!hasSource) {
      nodes.title.textContent = '교재';
      nodes.meta.textContent = '';
      nodes.searchResult.textContent = '';
      return;
    }
    nodes.title.textContent = source.title;
    const readable = source.pages.filter(page => page.state === 'draft').length;
    nodes.meta.textContent = `${source.originalName} · ${source.pages.length}쪽 가운데 글자 있는 쪽 ${readable}쪽`;
    if (!source.pages.some(page => page.pdfPageIndex === selected)) selected = source.pages[0].pdfPageIndex;
    const matches = query.trim() ? searchPages(source.pages, query) : [];
    nodes.searchResult.textContent = !query.trim() ? ''
      : matches.length === 0 ? `「${query.trim()}」을(를) 찾지 못했어요.`
        : `「${query.trim()}」: ${matches.length}쪽에서 ${matches.reduce((sum, match) => sum + match.count, 0)}곳`;
    renderList(matches);
    renderPage();
  }

  nodes.search.addEventListener('input', () => {
    query = nodes.search.value;
    const matches = query.trim() && source ? searchPages(source.pages, query) : [];
    // Jump to the first page with a hit unless the shown page already has one.
    if (matches.length > 0 && !matches.some(match => match.pdfPageIndex === selected)) selected = matches[0].pdfPageIndex;
    render();
  });

  return {
    async update() {
      source = await load();
      render();
    },
  };
}
