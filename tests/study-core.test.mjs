import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRanges, searchPages, sourcePages, unfence } from '../src/study-core.mjs';
import { manifestFromExtraction } from '../src/pdf-core.mjs';

const selectedPages = [1, 2, 3];
function extraction() {
  return manifestFromExtraction({
    sourceId: 'local-pdf-test', sourceHash: 'a'.repeat(64), title: '교육학', edition: 'test.pdf', selectedPages,
    extracted: {
      totalPages: 3,
      pages: [
        { pdfPageIndex: 1, printedPageLabel: '12', text: '형성평가는 학습 중에 한다.\n``` 코드 울타리도 글자다', imageCount: 0, error: null },
        { pdfPageIndex: 2, printedPageLabel: 'unknown', text: '', imageCount: 1, error: null },
        { pdfPageIndex: 3, printedPageLabel: 'unknown', text: '', imageCount: 0, error: 'bad page' },
      ],
    },
  });
}
const setup = { title: '교육학 1회독', source: { originalName: '교육학.pdf', selectedPages } };

test('pages show the extracted text without the draft fence, with printed labels and page states', () => {
  const result = extraction();
  const view = sourcePages({ setup, draft: { sourceId: 'local-pdf-test', manifest: result.manifest } });
  assert.equal(view.title, '교육학 1회독');
  assert.equal(view.originalName, '교육학.pdf');
  assert.deepEqual(view.pages.map(page => [page.pdfPageIndex, page.printedPageLabel, page.state]),
    [[1, '12', 'draft'], [2, null, 'textless'], [3, null, 'failed']]);
  assert.equal(view.pages[0].text, '형성평가는 학습 중에 한다.\n``` 코드 울타리도 글자다');
  assert.ok(view.pages[1].issues.some(issue => issue.includes('이미지 1개')));
  assert.ok(view.pages[2].issues.some(issue => issue.includes('추출 실패')));
});

test('no registered source means no pages (demo input), and a page missing from the draft is marked', () => {
  assert.equal(sourcePages({ setup: null, draft: null }), null);
  assert.equal(sourcePages({ setup, draft: null }), null);
  const result = extraction();
  const view = sourcePages({ setup: { ...setup, source: { ...setup.source, selectedPages: [1, 4] } },
    draft: { manifest: result.manifest } });
  assert.deepEqual(view.pages.map(page => page.state), ['draft', 'missing']);
});

test('unfence keeps text that is not a fenced draft block as it is', () => {
  assert.equal(unfence('````text\n안에 ``` 있음\n````'), '안에 ``` 있음');
  assert.equal(unfence('그냥 글'), '그냥 글');
  assert.equal(unfence(''), '');
});

test('search finds every occurrence, ignores Latin case and blank queries', () => {
  assert.deepEqual(matchRanges('평가 평가 평가', '평가'), [[0, 2], [3, 5], [6, 8]]);
  assert.deepEqual(matchRanges('Bloom and bloom', 'BLOOM'), [[0, 5], [10, 15]]);
  assert.deepEqual(matchRanges('형성평가', '   '), []);
  const pages = [{ pdfPageIndex: 1, text: '형성평가와 총괄평가' }, { pdfPageIndex: 2, text: '진단' }];
  assert.deepEqual(searchPages(pages, '평가'), [{ pdfPageIndex: 1, count: 2 }]);
  assert.deepEqual(searchPages(pages, '없는 말'), []);
});
