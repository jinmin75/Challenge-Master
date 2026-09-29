// Reads selected PDF pages with pdf.js. Shared by the Node extractor process and the web version, so it takes
// the loaded pdf.js module and resource URLs instead of importing either build. Errors keep the English messages
// that studentPdfError() maps to Korean.
const MAX_CONTENT_CHARS = 5_000_000;

function checkPages(pages, total) {
  if (!Array.isArray(pages) || !pages.every(Number.isInteger)) throw new Error('pages must be an integer array');
  const sorted = [...pages].sort((a, b) => a - b);
  if (pages.length === 0 || new Set(pages).size !== pages.length ||
      sorted.some((page, index) => page !== pages[index])) {
    throw new Error('pages must be nonempty, unique, and sorted');
  }
  if (pages.some(page => page < 1 || page > total)) throw new Error('page outside PDF');
}

function pageText(content) {
  let text = '';
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;
    text += item.str + (item.hasEOL ? '\n' : '');
    if (text.length > MAX_CONTENT_CHARS) throw new Error('page text exceeds 5,000,000 characters');
  }
  return text;
}

export async function readPdfPages(pdfjs, { data, pages, cMapUrl, standardFontDataUrl, wasmUrl, worker = null }) {
  const { getDocument, OPS, PasswordException } = pdfjs;
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject,
    OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObject].filter(Number.isInteger));
  let task;
  let doc;
  try {
    task = getDocument({
      data,
      // Korean PDFs often rely on predefined CMaps; without them text comes out empty.
      cMapUrl, cMapPacked: true, standardFontDataUrl, wasmUrl,
      useSystemFonts: false, disableFontFace: true, isEvalSupported: false, verbosity: 0,
      ...(worker ? { worker } : {}),
    });
    doc = await task.promise;
  } catch (error) {
    if (error instanceof PasswordException || error?.name === 'PasswordException') {
      throw new Error('encrypted PDF is not supported');
    }
    throw new Error(`cannot open PDF: ${String(error?.message ?? error).slice(0, 300)}`);
  }
  try {
    // Any encryption, even owner-only, is refused.
    if ((await doc.getMetadata()).info?.EncryptFilterName) throw new Error('encrypted PDF is not supported');
    // { first: n } asks for the first n pages, however long the PDF is (D024: the learner need not know its length).
    if (!Array.isArray(pages) && Number.isInteger(pages?.first)) {
      pages = Array.from({ length: Math.min(pages.first, doc.numPages) }, (_, index) => index + 1);
    }
    checkPages(pages, doc.numPages);
    const labels = await doc.getPageLabels();
    const results = [];
    for (const number of pages) {
      let text = '';
      let imageCount = 0;
      let error = null;
      try {
        const page = await doc.getPage(number);
        text = pageText(await page.getTextContent());
        try {
          const operators = await page.getOperatorList();
          imageCount = operators.fnArray.filter(op => imageOps.has(op)).length;
        } catch (imageError) {
          error = `image inspection failed: ${imageError?.message ?? imageError}`.slice(0, 300);
        }
      } catch (pageError) {
        error = String(pageError?.message ?? pageError).slice(0, 300);
      }
      const label = labels?.[number - 1];
      results.push({ pdfPageIndex: number, printedPageLabel: label ? String(label) : 'unknown',
        text, imageCount, error });
    }
    return { totalPages: doc.numPages, pages: results };
  } finally {
    await task.destroy();
  }
}
