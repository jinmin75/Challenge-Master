// Study features of the web version (D023): pure helpers shared by the page and the unit tests.
// No Node or browser APIs. Step A-1 turns the stored PDF extraction into readable pages and finds words in them.

// The draft keeps each page as a fenced ```text block (pdf-core.mjs); the reader shows the text inside.
export function unfence(markdown = '') {
  const match = /^(`{3,})text\n([\s\S]*)\n\1$/.exec(markdown);
  return match ? match[2] : markdown;
}

// The registered source as pages to read. Returns null before a PDF is registered (demo input).
export function sourcePages({ setup, draft } = {}) {
  if (!setup?.source || !draft?.manifest?.pages) return null;
  const pages = (setup.source.selectedPages ?? []).map(number => {
    const page = draft.manifest.pages[String(number)] ?? null;
    const text = page ? unfence(page.markdown) : '';
    const label = page && page.printedPageLabel && page.printedPageLabel !== 'unknown' ? page.printedPageLabel : null;
    let state = 'draft';
    if (!page) state = 'missing';
    else if (page.status === 'failed') state = 'failed';
    else if (!text) state = 'textless';
    return {
      pdfPageIndex: number,
      printedPageLabel: label,
      state,
      text,
      issues: page?.validation?.issues ?? [],
    };
  });
  return {
    title: setup.title,
    originalName: setup.source.originalName,
    sourceId: draft.sourceId ?? null,
    pages,
  };
}

function normalize(value) {
  return String(value ?? '').toLocaleLowerCase('ko-KR');
}

// Start/end offsets of every match of `query` in `text` (case-insensitive for Latin letters, as typed for Korean).
export function matchRanges(text, query) {
  const needle = normalize(query).trim();
  if (!needle) return [];
  const haystack = normalize(text);
  const ranges = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    ranges.push([at, at + needle.length]);
  }
  return ranges;
}

// Pages that contain the query, with how many times it appears on each.
export function searchPages(pages, query) {
  return pages
    .map(page => ({ pdfPageIndex: page.pdfPageIndex, count: matchRanges(page.text, query).length }))
    .filter(result => result.count > 0);
}
