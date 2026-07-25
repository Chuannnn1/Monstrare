import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] || '';

test('frontend inline script 可編譯，且包含 project/token controls', () => {
  assert.doesNotThrow(() => new Function(script));
  assert.match(html, /id="project-select"/);
  assert.match(html, /id="project-form"/);
  assert.match(html, /id="token-input"/);
  assert.match(script, /Authorization = "Bearer " \+ API_TOKEN/);
});

test('frontend writes 使用 project-scoped API，不再呼叫 legacy global endpoints', () => {
  assert.match(script, /projectPath\(ACTIVE_PROJECT, "\/cards"\)/);
  assert.match(script, /projectPath\(pid, "\/cards\/" \+ encodeURIComponent\(tk\.id\)\)/);
  assert.match(script, /projectPath\(project\.id, "\/epics"\)/);
  assert.doesNotMatch(script, /api\("\/api\/epics"/);
  assert.doesNotMatch(script, /api\("\/api\/cards\/"/);
});
