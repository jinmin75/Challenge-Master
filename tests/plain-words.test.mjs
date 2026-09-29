import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// D024 / moa-lessons #11: the screens speak the learner's words. Words the learner had to learn in v0.9 must not come
// back into anything the screens show (comments are code notes, not screen text, and are left out).
const OLD_WORDS = ['과업', '배정', '사후 기록', '누락', '보완', '학습실', '오답노트', '학습로그', '잠김:', '원문과 대조',
  '추출 초안', '원본 대조', '확인 필요', '학습 마무리', '요약 승인', '오늘 시작', '다시 배정', '동의하고', '철회'];

function screenText(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(line => line.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');
}

test('screen text has none of the old names the learner had to learn (D024)', () => {
  const web = join(import.meta.dirname, '..', 'web');
  const files = readdirSync(web).filter(name => /\.(js|html)$/.test(name));
  const found = [];
  for (const file of files) {
    const text = screenText(readFileSync(join(web, file), 'utf8'));
    for (const word of OLD_WORDS) {
      if (text.includes(word)) found.push(`${file}: ${word}`);
    }
  }
  assert.deepEqual(found, []);
});
