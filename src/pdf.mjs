import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyPageResult, summarizeManifest } from './ingest.mjs';
import { MAX_PDF_BYTES, manifestFromExtraction, renderPdfDraft } from './pdf-core.mjs';

export { renderPdfDraft };
// V8 heap cap for the extractor process; untrusted PDFs can expand compressed streams.
const EXTRACTOR_HEAP_MB = 512;

export function convertPdf({ pdfPath, sourceId, title, edition, selectedPages }) {
  if (typeof pdfPath !== 'string' || pdfPath.trim() === '') throw new Error('pdfPath is required');
  if (!Array.isArray(selectedPages)) throw new Error('selectedPages must be an array');
  const pdf = resolve(pdfPath);
  if (statSync(pdf).size > MAX_PDF_BYTES) throw new Error('PDF exceeds 50 MiB local extraction limit');
  const bytes = readFileSync(pdf);
  if (bytes.length > MAX_PDF_BYTES) throw new Error('PDF exceeds 50 MiB local extraction limit');
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('input is not a PDF');
  const sourceHash = createHash('sha256').update(bytes).digest('hex');
  const helper = resolve(import.meta.dirname, 'pdf-extract.mjs');
  const child = spawnSync(process.execPath,
    [`--max-old-space-size=${EXTRACTOR_HEAP_MB}`, helper, pdf, JSON.stringify(selectedPages)], {
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
  return manifestFromExtraction({ sourceId, sourceHash, title, edition, selectedPages, extracted });
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

