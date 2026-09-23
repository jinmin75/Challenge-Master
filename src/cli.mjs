import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { planDay } from './scheduler.mjs';
import { planFromProgress } from './replan.mjs';
import { createManifest, applyPageResult, summarizeManifest, renderFaithfulMarkdown } from './ingest.mjs';
import { readStore, appendToStore } from './store.mjs';

const usage = `Challenge Master — 개발용 로컬 코어 (학생용 화면·LLM·PDF 변환기 미연결)
  node src/cli.mjs demo
  node src/cli.mjs plan <input.json> [--store private/study.json]
  node src/cli.mjs replan <input.json> --store private/study.json
  node src/cli.mjs record <event.json> --store private/study.json
  node src/cli.mjs status --store private/study.json
기록은 평문 로컬 파일입니다. 공유 폴더·공개 저장소에 보관하지 마세요.`;

function readJson(file) {
  if (statSync(file).size > 5 * 1024 * 1024) throw new Error('입력 파일은 5 MiB 이하여야 합니다.');
  return JSON.parse(readFileSync(file, 'utf8'));
}

function output(value) { console.log(JSON.stringify(value, null, 2)); }

function storeArg(args, offset, required) {
  if (args.length === offset && !required) return null;
  if (args.length !== offset + 2 || args[offset] !== '--store' || !args[offset + 1]) throw new Error(usage);
  return args[offset + 1];
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
