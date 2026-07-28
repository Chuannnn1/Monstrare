import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';
const blueprintCanvas = readFileSync(new URL('../blueprint-canvas.jsx', import.meta.url), 'utf8');

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
  assert.match(html, /flex: 0 0 282px/);
  assert.match(html, /Segoe UI Variable Text/);
  assert.match(html, /@media \(max-width: 760px\)/);
  assert.doesNotMatch(html, /linear-gradient/);
});

test('typography 使用可讀字級、繁中 fallback 與高對比 secondary text', () => {
  assert.match(html, /--ink-dim: #b5bec8/);
  assert.match(html, /--ink-faint: #7f8b99/);
  assert.match(html, /Microsoft JhengHei UI/);
  assert.match(html, /\.ticket-title \{ font-size: 15px/);
  assert.match(html, /\.blueprint-panel-title \{ font-size: 14px/);
  assert.match(html, /font-synthesis: none/);
  assert.doesNotMatch(html, /-webkit-font-smoothing:\s*antialiased/);
});

test('Blueprint canvas 放大語意節點文字，窄畫面優先聚焦單一節點', () => {
  assert.match(blueprintCanvas, /fontSize: 21/);
  assert.match(blueprintCanvas, /rootElement\.clientWidth < 600/);
  assert.match(blueprintCanvas, /nodeElements\.slice\(0, 1\)/);
  assert.match(blueprintCanvas, /viewportZoomFactor: compact \? 0\.9 : 0\.96/);
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
  assert.match(html, /data-view="roadmap" role="tab">路線圖/);
});

test('Blueprint workbench 接上 canvas、discussion、proposal 與 materialize flows', () => {
  assert.match(html, /<html lang="zh-Hant">/);
  assert.match(html, /src="\/kanban-assets\/app\/blueprint-canvas\.js"/);
  assert.match(html, /id="blueprint-canvas-root"/);
  assert.match(html, /id="blueprint-discussion-list"/);
  assert.match(html, /id="blueprint-proposal-list"/);
  assert.match(script, /activeBlueprintApi\("\/discussions"\)/);
  assert.match(script, /activeBlueprintApi\("\/materialize"\)/);
  assert.match(script, /data-proposal-action/);
  assert.match(script, /"\/claim"/);
  assert.match(
    script,
    /TICKETS = TICKETS\.concat\(result\.cards\);\s*renderProjectControls\(\);\s*renderLanes\(\);/,
    'materialize 後應同步 sidebar 計數與 Kanban lanes',
  );
});

test('agent proposal 可先投影到 Excalidraw，preview 不得寫回正式 layout', () => {
  assert.match(script, /function applyProposalPreview/);
  assert.match(script, /data-proposal-preview/);
  assert.match(script, /previewNodeIds/);
  assert.match(script, /PREVIEW_PROPOSAL_ID/);
  assert.match(blueprintCanvas, /strokeStyle: isPreview \? "dashed" : "solid"/);
  assert.match(blueprintCanvas, /isPreviewRef\.current/);
  assert.match(blueprintCanvas, /if \(isPreviewRef\.current\) return/);
});

test('介面文案避免混用舊版 AI workflow 樣板字詞', () => {
  assert.doesNotMatch(html, /STREAM READY|ALL PROJECTS|Agent Operations/);
  assert.doesNotMatch(html, /spec-interrogation|implementation-plan/);
  assert.doesNotMatch(html, /⚠️|⛔|🔗/);
});
