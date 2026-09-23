import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { applySourceReview, convertPdf } from '../src/pdf.mjs';
import { renderFaithfulMarkdown } from '../src/ingest.mjs';

function tinyPdf({ korean = false } = {}) {
  const stream = korean ? 'BT /F1 14 Tf 72 720 Td <01> Tj ET'
    : 'BT /F1 14 Tf 72 720 Td (Synthetic page one) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    korean ? '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 8 0 R >>'
      : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Length 0 >>\nstream\n\nendstream'
  ];
  if (korean) {
    const cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n'
      + '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n'
      + '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n'
      + '1 begincodespacerange\n<00> <FF>\nendcodespacerange\n'
      + '1 beginbfchar\n<01> <D55C>\nendbfchar\n'
      + 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
    objects.push(`<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`);
  }
  let document = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) document += `${String(offset).padStart(10, '0')} 00000 n \n`;
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document, 'latin1');
}

test('actual PDF pages become traced local drafts without false ready or mastery', () => {
  const folder = mkdtempSync(join(tmpdir(), 'challenge-pdf-'));
  const path = join(folder, 'synthetic.pdf');
  const original = tinyPdf();
  writeFileSync(path, original);
  const result = convertPdf({ pdfPath: path, sourceId: 'synthetic', title: 'Synthetic',
    edition: 'v1', selectedPages: [1, 2] });
  assert.equal(result.summary.sourceHash, createHash('sha256').update(original).digest('hex'));
  assert.equal(result.summary.status, 'partial');
  assert.deepEqual(result.summary.needsReviewPages, [1, 2]);
  assert.deepEqual(result.summary.readyPages, []);
  assert.equal(result.summary.masteryEvidence, false);
  assert.match(result.draftMarkdown, /Synthetic page one/);
  assert.match(result.draftMarkdown, /draft_only: do_not_use_as_verified_evidence/);
  assert.equal(result.manifest.pages['1'].printedPageLabel, 'unknown');
  assert.equal(result.manifest.pages['2'].markdown, '');
  assert.deepEqual(readFileSync(path), original);
  assert.deepEqual(convertPdf({ pdfPath: path, sourceId: 'synthetic', title: 'Synthetic',
    edition: 'v1', selectedPages: [1, 2] }), result);
});

test('PDF extraction preserves Korean text through the Python JSON pipe', () => {
  const folder = mkdtempSync(join(tmpdir(), 'challenge-pdf-ko-'));
  const path = join(folder, 'korean.pdf');
  writeFileSync(path, tinyPdf({ korean: true }));
  const result = convertPdf({ pdfPath: path, sourceId: 'korean-test', title: '한글 시험',
    edition: 'v1', selectedPages: [1] });
  assert.match(result.manifest.pages['1'].markdown, /한/);
  assert.match(result.draftMarkdown, /한/);
});

test('out-of-range selection and non-PDF fail before producing an artifact', () => {
  const folder = mkdtempSync(join(tmpdir(), 'challenge-pdf-'));
  const path = join(folder, 'synthetic.pdf');
  writeFileSync(path, tinyPdf());
  assert.throws(() => convertPdf({ pdfPath: path, sourceId: 'synthetic', title: 'Synthetic',
    edition: 'v1', selectedPages: [3] }), /PDF extraction failed|page outside PDF/);
  assert.throws(() => convertPdf({ pdfPath: path, sourceId: 'synthetic', title: 'Synthetic',
    edition: 'v1', selectedPages: [2, 1] }), /PDF extraction failed|sorted/);
  writeFileSync(path, 'not-a-pdf');
  assert.throws(() => convertPdf({ pdfPath: path, sourceId: 'synthetic', title: 'Synthetic',
    edition: 'v1', selectedPages: [1] }), /not a PDF/);
});

test('source review requires the same PDF, conversion version, and exact draft', () => {
  const folder = mkdtempSync(join(tmpdir(), 'challenge-review-'));
  const path = join(folder, 'synthetic.pdf');
  const original = tinyPdf();
  writeFileSync(path, original);
  const { manifest } = convertPdf({ pdfPath: path, sourceId: 'synthetic', title: 'Synthetic',
    edition: 'v1', selectedPages: [1] });
  const review = { sourceHash: manifest.source.sourceHash,
    conversionVersion: manifest.source.conversionVersion,
    pages: [{ pdfPageIndex: 1, reviewerConfirmed: true, sourceCompared: true, structureChecked: true,
      draftSha256: createHash('sha256').update(manifest.pages['1'].markdown).digest('hex') }] };
  assert.throws(() => applySourceReview(manifest, manifest,
    { ...review, pages: [{ ...review.pages[0], draftSha256: 'a'.repeat(64) }] }, original), /incomplete or stale/);
  assert.throws(() => applySourceReview(manifest, manifest, review, Buffer.from('changed')), /source hash/);
  const result = applySourceReview(manifest, manifest, review, original);
  assert.deepEqual(result.summary.readyPages, [1]);
  assert.match(renderFaithfulMarkdown(result.manifest), /Synthetic page one/);
  assert.equal(applySourceReview(manifest, result.manifest, review, original).summary.status, 'ready');
  const changedPage = structuredClone(result.manifest);
  changedPage.pages['1'].markdown = 'Altered text';
  changedPage.pages['1'].input.markdown = 'Altered text';
  assert.throws(() => applySourceReview(manifest, changedPage, review, original), /reviewed page 1 was changed/);
  const changedTitle = structuredClone(result.manifest);
  changedTitle.source.title = 'Different title';
  changedTitle.provenance.title = 'Different title';
  assert.throws(() => applySourceReview(manifest, changedTitle, review, original), /source mismatch/);
});

test('PDF CLI saves a repeatable private draft and rejects executable metadata', () => {
  const folder = mkdtempSync(join(tmpdir(), 'challenge-pdf-cli-'));
  const pdf = join(folder, 'synthetic.pdf');
  const metadata = join(folder, 'metadata.json');
  const out = join(folder, 'converted');
  writeFileSync(pdf, tinyPdf());
  writeFileSync(metadata, JSON.stringify({ sourceId: 'synthetic', title: 'Synthetic', edition: 'v1', selectedPages: [1] }));
  const run = () => spawnSync(process.execPath, ['src/cli.mjs', 'pdf', pdf, metadata, '--out', out], {
    cwd: join(import.meta.dirname, '..'), encoding: 'utf8'
  });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).verifiedMarkdown, false);
  const saved = readFileSync(join(out, 'draft.md'), 'utf8');
  assert.match(saved, /Synthetic page one/);
  assert.equal(run().status, 0);
  assert.equal(readFileSync(join(out, 'draft.md'), 'utf8'), saved);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  const reviewPath = join(folder, 'review.json');
  writeFileSync(reviewPath, JSON.stringify({ sourceHash: manifest.source.sourceHash,
    conversionVersion: manifest.source.conversionVersion,
    pages: [{ pdfPageIndex: 1, reviewerConfirmed: true, sourceCompared: true, structureChecked: true,
      draftSha256: createHash('sha256').update(manifest.pages['1'].markdown).digest('hex') }] }));
  const reviewed = spawnSync(process.execPath, ['src/cli.mjs', 'pdf-review', out, pdf, reviewPath], {
    cwd: join(import.meta.dirname, '..'), encoding: 'utf8'
  });
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.match(readFileSync(join(out, 'faithful.md'), 'utf8'), /Synthetic page one/);
  const alteredDraft = structuredClone(manifest);
  alteredDraft.pages['1'].markdown = 'Altered draft';
  alteredDraft.pages['1'].input.markdown = 'Altered draft';
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(alteredDraft));
  const rejected = spawnSync(process.execPath, ['src/cli.mjs', 'pdf-review', out, pdf, reviewPath], {
    cwd: join(import.meta.dirname, '..'), encoding: 'utf8'
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /다시 추출한 초안/);
  writeFileSync(metadata, JSON.stringify({ sourceId: 'synthetic', title: 'Synthetic', edition: 'v1',
    selectedPages: [1], python: 'untrusted-program' }));
  assert.equal(run().status, 1);
  assert.equal(readFileSync(join(out, 'draft.md'), 'utf8'), saved);
});
