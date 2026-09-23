import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyPageResult, createManifest, summarizeManifest } from './ingest.mjs';

const CONVERSION_VERSION = 'pypdf-layout-v1';
const MAX_PDF_BYTES = 50 * 1024 * 1024;

export function convertPdf({ pdfPath, sourceId, title, edition, selectedPages,
  python = process.env.CHALLENGE_MASTER_PYTHON ?? 'python' }) {
  if (typeof pdfPath !== 'string' || pdfPath.trim() === '') throw new Error('pdfPath is required');
  if (!Array.isArray(selectedPages)) throw new Error('selectedPages must be an array');
  const pdf = resolve(pdfPath);
  if (statSync(pdf).size > MAX_PDF_BYTES) throw new Error('PDF exceeds 50 MiB local extraction limit');
  const bytes = readFileSync(pdf);
  if (bytes.length > MAX_PDF_BYTES) throw new Error('PDF exceeds 50 MiB local extraction limit');
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('input is not a PDF');
  const sourceHash = createHash('sha256').update(bytes).digest('hex');
  const helper = resolve(import.meta.dirname, '../scripts/pdf_extract.py');
  const child = spawnSync(python, [helper, pdf, JSON.stringify(selectedPages)], {
    encoding: 'utf8', maxBuffer: 25 * 1024 * 1024, timeout: 60_000, windowsHide: true
  });
  if (child.error || child.status !== 0) {
    throw new Error(`PDF extraction failed: ${(child.stderr || child.error?.message || 'unknown error').trim()}`);
  }
  let extracted;
  try { extracted = JSON.parse(child.stdout); } catch { throw new Error('PDF extractor returned invalid JSON'); }
  if (createHash('sha256').update(readFileSync(pdf)).digest('hex') !== sourceHash) {
    throw new Error('PDF changed during extraction');
  }
  if (!Number.isInteger(extracted.totalPages) || extracted.totalPages < 1 || !Array.isArray(extracted.pages)) {
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

export function applySourceReview(draftManifest, currentManifest, review, pdfBytes) {
  const draft = summarizeManifest(draftManifest);
  const current = summarizeManifest(currentManifest);
  if (canonical(draftManifest.source) !== canonical(currentManifest.source) ||
      canonical(draftManifest.provenance) !== canonical(currentManifest.provenance) ||
      canonical(Object.keys(draftManifest.pages).sort()) !== canonical(Object.keys(currentManifest.pages).sort()) ||
      canonical(draft.selectedPages) !== canonical(current.selectedPages)) {
    throw new Error('review manifest source mismatch');
  }
  for (const number of draft.selectedPages) {
    const original = draftManifest.pages[String(number)];
    const saved = currentManifest.pages[String(number)];
    if (!original || !saved) throw new Error('review manifest page mismatch');
    if (saved.status === 'ready' && original.status === 'needs_review') {
      const expected = applyPageResult(draftManifest, {
        pdfPageIndex: number, printedPageLabel: original.printedPageLabel,
        markdown: original.markdown, status: 'ready',
        validation: { structureChecked: true, sourceCompared: true, issues: [] }
      }).pages[String(number)];
      if (canonical(saved) !== canonical(expected)) throw new Error(`reviewed page ${number} was changed`);
    } else if (canonical(saved) !== canonical(original)) {
      throw new Error(`reviewed page ${number} was changed`);
    }
  }
  const actualHash = createHash('sha256').update(pdfBytes).digest('hex');
  if (actualHash !== draft.sourceHash || review?.sourceHash !== draft.sourceHash ||
      review?.conversionVersion !== draft.conversionVersion) {
    throw new Error('review source hash or conversion version mismatch');
  }
  if (!Array.isArray(review.pages) || review.pages.length === 0) throw new Error('review pages are required');
  let next = currentManifest;
  const seen = new Set();
  for (const item of review.pages) {
    if (!item || !Number.isInteger(item.pdfPageIndex) || seen.has(item.pdfPageIndex)) {
      throw new Error('review page index is invalid or duplicate');
    }
    seen.add(item.pdfPageIndex);
    const page = draftManifest.pages[String(item.pdfPageIndex)];
    if (!page || page.status !== 'needs_review' || !page.markdown) {
      throw new Error(`page ${item.pdfPageIndex} has no reviewable extracted text`);
    }
    if (item.sourceCompared !== true || item.structureChecked !== true || item.reviewerConfirmed !== true ||
        item.draftSha256 !== createHash('sha256').update(page.markdown).digest('hex')) {
      throw new Error(`page ${item.pdfPageIndex} review is incomplete or stale`);
    }
    next = applyPageResult(next, {
      pdfPageIndex: item.pdfPageIndex,
      printedPageLabel: page.printedPageLabel,
      markdown: page.markdown,
      status: 'ready',
      validation: { structureChecked: true, sourceCompared: true, issues: [] }
    });
  }
  return { manifest: next, summary: summarizeManifest(next) };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fencedText(value) {
  const longest = Math.max(2, ...[...value.matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${value}\n${fence}`;
}

function safeComment(value) { return String(value).replaceAll('--', '- -').replaceAll('-->', '- ->'); }
