import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { planDay } from './scheduler.mjs';
import { planFromProgress } from './replan.mjs';
import { planWeek } from './weekly.mjs';
import { createManifest, applyPageResult, summarizeManifest, renderFaithfulMarkdown } from './ingest.mjs';
import { applySourceReview, convertPdf } from './pdf.mjs';
import { readStore, appendToStore } from './store.mjs';

const usage = `Challenge Master — 로컬 학습 도구
  node src/cli.mjs demo
  node src/cli.mjs plan <input.json> [--store private/study.json]
  node src/cli.mjs replan <input.json> --store private/study.json
  node src/cli.mjs week <input.json> [--store private/study.json]
  node src/cli.mjs pdf <source.pdf> <metadata.json> [--out private/ingest/name]
  node src/cli.mjs pdf-review <out-dir> <source.pdf> <review.json>
  node src/cli.mjs record <event.json> --store private/study.json
  node src/cli.mjs status --store private/study.json
기록은 평문 로컬 파일입니다. 공유 폴더·공개 저장소에 보관하지 마세요.`;

function readJson(file, maxBytes = 5 * 1024 * 1024) {
  if (statSync(file).size > maxBytes) throw new Error(`입력 파일은 ${Math.floor(maxBytes / 1024 / 1024)} MiB 이하여야 합니다.`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

function output(value) { console.log(JSON.stringify(value, null, 2)); }

function storeArg(args, offset, required) {
  if (args.length === offset && !required) return null;
  if (args.length !== offset + 2 || args[offset] !== '--store' || !args[offset + 1]) throw new Error(usage);
  return args[offset + 1];
}

function writeMatching(file, content) {
  if (existsSync(file)) {
    if (readFileSync(file, 'utf8') !== content) throw new Error(`기존 반입 결과와 충돌합니다: ${file}`);
    return;
  }
  writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' });
}

function writeAtomic(file, content) {
  const temporary = resolve(file, `../.${basename(file)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function pdfOutputDir(requested, manifest, metadata) {
  const root = resolve(import.meta.dirname, '..');
  const key = createHash('sha256').update(JSON.stringify(metadata)).digest('hex').slice(0, 16);
  const dataRoot = process.env.CHALLENGE_MASTER_DATA_DIR ?? resolve(root, 'private');
  const path = resolve(requested ?? resolve(dataRoot, 'ingest', manifest.source.sourceHash, key));
  const inside = relative(root, path);
  if (inside === '' || (!isAbsolute(inside) && !inside.startsWith(`..${sep}`) && inside !== '..' &&
      inside !== 'private' && !inside.startsWith(`private${sep}`))) {
    throw new Error('저장소 안의 PDF 추출본은 private/ 아래에만 저장할 수 있습니다.');
  }
  return path;
}

try {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === '--help') {
    if (args.length > 1) throw new Error(usage);
    console.log(usage);
  } else if (command === 'demo') {
    if (args.length !== 1) throw new Error(usage);
    const plan = planDay(readJson(resolve(import.meta.dirname, '../fixtures/synthetic-plan.json')));
    let manifest = createManifest({ sourceId: 'synthetic-source', sourceHash: 'a'.repeat(64), title: '합성 자료',
      edition: '검증용', totalPages: 2, selectedPages: [1, 2], conversionVersion: 'synthetic-v1' });
    manifest = applyPageResult(manifest, { pdfPageIndex: 1, printedPageLabel: '3',
      markdown: '# 합성 단원\n실제 교재가 아닌 검증용 문장입니다.', status: 'ready',
      validation: { structureChecked: true, sourceCompared: true, issues: [] } });
    output({ mode: 'synthetic_no_models', plan, ingest: summarizeManifest(manifest),
      faithfulMarkdown: renderFaithfulMarkdown(manifest), pdfConversionImplemented: false });
  } else if (command === 'plan') {
    if (!args[1] || args[1].startsWith('--')) throw new Error(usage);
    const store = storeArg(args, 2, false);
    const input = readJson(args[1]);
    if (store && input.completedTaskIds !== undefined) {
      throw new Error('저장 계획에는 completedTaskIds를 넣을 수 없습니다. 완료 기록은 별도 이벤트로 남기세요.');
    }
    const state = store ? appendToStore(store, before => {
      if (before.currentPlan) throw new Error('다음 계획은 replan으로 생성하세요.');
      return { id: randomUUID(), type: 'plan_created', at: new Date().toISOString(),
        plan: planDay({ ...input, planVersion: (before.currentPlan?.planVersion ?? 0) + 1 }) };
    }) : null;
    const plan = state?.currentPlan ?? planDay({ ...input, planVersion: 1 });
    output({ plan, saved: Boolean(store) });
  } else if (command === 'replan') {
    if (!args[1] || args[1].startsWith('--')) throw new Error(usage);
    const store = storeArg(args, 2, true);
    const input = readJson(args[1]);
    const state = appendToStore(store, before => ({ id: randomUUID(), type: 'plan_created',
      at: new Date().toISOString(), plan: planFromProgress(input, before) }));
    output({ plan: state.currentPlan, saved: true });
  } else if (command === 'week') {
    if (!args[1] || args[1].startsWith('--')) throw new Error(usage);
    const store = storeArg(args, 2, false);
    output({ forecast: planWeek(readJson(args[1]), store ? readStore(store) : { progress: [], plans: [] }), saved: false });
  } else if (command === 'pdf') {
    if (!args[1] || !args[2] || args[1].startsWith('--') || args[2].startsWith('--')) throw new Error(usage);
    if (args.length !== 3 && (args.length !== 5 || args[3] !== '--out' || !args[4])) throw new Error(usage);
    const metadata = readJson(args[2]);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
        Object.keys(metadata).some(key => !['sourceId', 'title', 'edition', 'selectedPages'].includes(key))) {
      throw new Error('PDF metadata는 sourceId, title, edition, selectedPages만 허용합니다.');
    }
    const conversion = convertPdf({ pdfPath: args[1], sourceId: metadata.sourceId,
      title: metadata.title, edition: metadata.edition, selectedPages: metadata.selectedPages });
    const manifestContent = JSON.stringify(conversion.manifest, null, 2) + '\n';
    if (Buffer.byteLength(manifestContent) > 32 * 1024 * 1024) {
      throw new Error('PDF 추출 결과가 검토 가능한 32 MiB 제한을 초과했습니다. 쪽 범위를 줄여 주세요.');
    }
    const outDir = pdfOutputDir(args[4], conversion.manifest, metadata);
    mkdirSync(outDir, { recursive: true });
    writeMatching(resolve(outDir, 'manifest.json'), manifestContent);
    writeMatching(resolve(outDir, 'draft.md'), conversion.draftMarkdown);
    const reviewTemplate = {
      sourceHash: conversion.manifest.source.sourceHash,
      conversionVersion: conversion.manifest.source.conversionVersion,
      pages: conversion.manifest.source.selectedPages
        .map(pageNumber => conversion.manifest.pages[String(pageNumber)])
        .filter(page => page.status === 'needs_review' && page.markdown)
        .map(page => ({ pdfPageIndex: page.pdfPageIndex,
          draftSha256: createHash('sha256').update(page.markdown).digest('hex'),
          structureChecked: false, sourceCompared: false, reviewerConfirmed: false }))
    };
    writeMatching(resolve(outDir, 'review-template.json'), JSON.stringify(reviewTemplate, null, 2) + '\n');
    output({ summary: conversion.summary, outDir, saved: true, verifiedMarkdown: false });
  } else if (command === 'pdf-review') {
    if (args.length !== 4 || args.slice(1).some(item => item.startsWith('--'))) throw new Error(usage);
    const outDir = resolve(args[1]);
    const draft = readJson(resolve(outDir, 'manifest.json'), 32 * 1024 * 1024);
    const fresh = convertPdf({ pdfPath: args[2], sourceId: draft.source.sourceId,
      title: draft.source.title, edition: draft.source.edition,
      selectedPages: draft.source.selectedPages });
    if (JSON.stringify(fresh.manifest) !== JSON.stringify(draft)) {
      throw new Error('PDF에서 다시 추출한 초안이 저장된 manifest와 다릅니다.');
    }
    const reviewedPath = resolve(outDir, 'reviewed-manifest.json');
    const current = existsSync(reviewedPath) ? readJson(reviewedPath, 32 * 1024 * 1024) : draft;
    const result = applySourceReview(draft, current, readJson(args[3]), readFileSync(args[2]));
    writeAtomic(reviewedPath, JSON.stringify(result.manifest, null, 2) + '\n');
    writeAtomic(resolve(outDir, 'faithful.md'), renderFaithfulMarkdown(result.manifest));
    output({ summary: result.summary, outDir, saved: true, verifiedMarkdown: true });
  } else if (command === 'record') {
    if (!args[1] || args[1].startsWith('--')) throw new Error(usage);
    const store = storeArg(args, 2, true);
    const event = readJson(args[1]);
    if (event.type === 'plan_created') throw new Error('계획은 plan 또는 replan 명령으로 만드세요.');
    const state = appendToStore(store, event);
    output({ saved: true, eventCount: state.events.length, currentPlanVersion: state.currentPlan?.planVersion ?? null });
  } else if (command === 'status') {
    output(readStore(storeArg(args, 1, true)));
  } else throw new Error(usage);
} catch (error) {
  console.error(`오류: ${error.message}`);
  process.exitCode = 1;
}
