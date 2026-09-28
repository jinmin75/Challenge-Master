// Turns pdf.js page results into the draft manifest and Markdown. No Node or browser APIs, so the local app
// and the web version build identical drafts from identical extraction results.
import { applyPageResult, createManifest, summarizeManifest } from './ingest.mjs';

export const CONVERSION_VERSION = 'pdfjs-text-v1';
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

export function manifestFromExtraction({ sourceId, sourceHash, title, edition, selectedPages, extracted }) {
  if (!Number.isInteger(extracted?.totalPages) || extracted.totalPages < 1 || !Array.isArray(extracted.pages)) {
    throw new Error('PDF extractor result is malformed');
  }
  let manifest = createManifest({ sourceId, sourceHash, title, edition,
    totalPages: extracted.totalPages, selectedPages, conversionVersion: CONVERSION_VERSION });
  if (extracted.pages.length !== selectedPages.length) throw new Error('PDF extractor omitted pages');
  for (const [index, page] of extracted.pages.entries()) {
    if (page.pdfPageIndex !== selectedPages[index] || typeof page.text !== 'string' ||
        !Number.isInteger(page.imageCount) || page.imageCount < 0 ||
        typeof page.printedPageLabel !== 'string' ||
        (page.error !== null && typeof page.error !== 'string')) {
      throw new Error('PDF extractor page result is malformed');
    }
    const text = page.text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
    const issues = [];
    if (page.error) issues.push(`추출 실패: ${page.error}`);
    if (!text) issues.push('추출된 텍스트 없음: 스캔 또는 빈 페이지 확인 필요');
    if (page.imageCount > 0) issues.push(`이미지 ${page.imageCount}개: 도표·그림·스캔 내용 확인 필요`);
    if (text) issues.push('원본 PDF와 텍스트·순서·표·수식 대조 필요');
    manifest = applyPageResult(manifest, {
      pdfPageIndex: page.pdfPageIndex,
      printedPageLabel: page.printedPageLabel,
      markdown: text ? fencedText(text) : '',
      status: page.error && (!text || !page.error.startsWith('image inspection failed:'))
        ? 'failed' : 'needs_review',
      validation: { structureChecked: !page.error, sourceCompared: false, issues }
    });
  }
  return { manifest, summary: summarizeManifest(manifest), draftMarkdown: renderPdfDraft(manifest) };
}

export function renderPdfDraft(manifest) {
  const summary = summarizeManifest(manifest);
  const lines = [
    `<!-- source_id: ${safeComment(summary.sourceId)} -->`,
    `<!-- source_hash: ${summary.sourceHash} -->`,
    `<!-- conversion_version: ${safeComment(summary.conversionVersion)} -->`,
    '<!-- draft_only: do_not_use_as_verified_evidence -->', ''
  ];
  for (const number of summary.selectedPages) {
    const page = manifest.pages[String(number)];
    lines.push(`<!-- page_anchor: source:${safeComment(summary.sourceId)}#pdf-page-${number} -->`);
    lines.push(`<!-- printed_page_label: ${safeComment(page.printedPageLabel)} -->`);
    lines.push(`<!-- review_status: ${page.status} -->`);
    lines.push(page.markdown || '본문을 추출하지 못했습니다. 원본 PDF를 확인해 주세요.');
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

function fencedText(value) {
  const longest = Math.max(2, ...[...value.matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${value}\n${fence}`;
}

function safeComment(value) { return String(value).replaceAll('--', '- -').replaceAll('-->', '- ->'); }
