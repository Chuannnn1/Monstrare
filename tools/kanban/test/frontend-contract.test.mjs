import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] || '';

test('frontend inline script 可編譯，且包含 sidebar project/token controls', () => {
  assert.doesNotThrow(() => new Function(script));
  assert.match(html, /class="sidebar"/);
  assert.match(html, /id="project-nav"/);
  assert.match(html, /id="project-form"/);
  assert.match(html, /id="token-input"/);
  assert.match(script, /data-project-id/);
  assert.doesNotMatch(html, /id="project-select"/);
  assert.match(script, /Authorization = "Bearer " \+ API_TOKEN/);
});

test('frontend 使用 neutral dark-tech palette 與 responsive sidebar', () => {
  assert.match(html, /--paper: #090b0e/);
  assert.match(html, /--accent: #42c7d5/);
  assert.match(html, /grid-template-columns: 236px minmax\(0, 1fr\)/);
  assert.match(html, /@media \(max-width: 760px\)/);
  assert.doesNotMatch(html, /linear-gradient/);
});

test('frontend writes 使用 project-scoped API，不再呼叫 legacy global endpoints', () => {
  assert.match(script, /projectPath\(ACTIVE_PROJECT, "\/cards"\)/);
  assert.match(script, /projectPath\(pid, "\/cards\/" \+ encodeURIComponent\(tk\.id\)\)/);
  assert.match(script, /projectPath\(project\.id, "\/epics"\)/);
  assert.doesNotMatch(script, /api\("\/api\/epics"/);
  assert.doesNotMatch(script, /api\("\/api\/cards\/"/);
});

test('Blueprint view 使用 project-scoped documents 與 SSE revision stream', () => {
  assert.match(html, /id="view-blueprint"/);
  assert.match(html, /id="blueprint-stage"/);
  assert.match(html, /id="blueprint-stream-list"/);
  assert.match(script, /projectPath\(ACTIVE_PROJECT, "\/blueprints"\)/);
  assert.match(script, /new EventSource\(url\)/);
  assert.match(script, /blueprint-revision/);
  assert.match(html, /data-view="roadmap" role="tab">Roadmap/);
});
