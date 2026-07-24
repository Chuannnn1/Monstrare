// 跨專案看板 — TDD 契約測試（red 階段）。
// 對照設計：tools/kanban/docs/cross-project-design.md
//
// 這些測試針對 server 黑箱行為。在 server.mjs 尚未支援環境變數與跨專案
// API 之前，startServer() 會 readiness timeout，全部亮紅燈。實作後轉綠。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { startServer } from './helper.mjs';

// 1) server 必須尊重 KANBAN_PORT / KANBAN_DATA_DIR（可測試 + 可部署的前提）
test('server honors KANBAN_PORT + KANBAN_DATA_DIR（空資料目錄啟動、/api/cards 回空陣列）', async () => {
  const s = await startServer();
  try {
    const r = await s.api('GET', '/api/cards');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, []);
  } finally { s.stop(); }
});

// 2) 專案清單端點存在
test('GET /api/projects 回 200 + 陣列（初始為空）', async () => {
  const s = await startServer();
  try {
    const r = await s.api('GET', '/api/projects');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json), 'projects 應為陣列');
    assert.equal(r.json.length, 0);
  } finally { s.stop(); }
});

// 3) 新增專案
test('POST /api/projects 建立專案，清單反映且欄位齊全', async () => {
  const s = await startServer();
  try {
    const created = await s.api('POST', '/api/projects', { id: 'golem', name: 'Golem', prefix: 'GOLEM' });
    assert.equal(created.status, 201);

    const list = await s.api('GET', '/api/projects');
    assert.equal(list.status, 200);
    const golem = list.json.find((p) => p.id === 'golem');
    assert.ok(golem, '清單應含 golem');
    assert.equal(golem.name, 'Golem');
    assert.equal(golem.prefix, 'GOLEM');
  } finally { s.stop(); }
});

// 4) 專案內新增卡：id 用該專案 prefix、帶 project 欄位、檔案落在 cards/<pid>/
test('POST /api/projects/:pid/cards 產生 <PREFIX>-NNN、project 欄位、存 cards/<pid>/', async () => {
  const s = await startServer();
  try {
    await s.api('POST', '/api/projects', { id: 'golem', name: 'Golem', prefix: 'GOLEM' });
    const c = await s.api('POST', '/api/projects/golem/cards', { title: 'Gemini timeout 保護', stage: 'ready' });
    assert.equal(c.status, 201);
    assert.match(c.json.id, /^GOLEM-\d{3,}$/);
    assert.equal(c.json.project, 'golem');
    assert.ok(
      existsSync(path.join(s.dataDir, 'cards', 'golem', c.json.id + '.json')),
      '卡片檔應存在 cards/golem/ 底下'
    );
  } finally { s.stop(); }
});

// 5) 讀單一專案卡片
test('GET /api/projects/:pid/cards 回該專案卡片', async () => {
  const s = await startServer();
  try {
    await s.api('POST', '/api/projects', { id: 'nekosub', name: 'NekoSub', prefix: 'NEKO' });
    const c = await s.api('POST', '/api/projects/nekosub/cards', { title: 'tokenizer v2', stage: 'implementing' });
    const list = await s.api('GET', '/api/projects/nekosub/cards');
    assert.equal(list.status, 200);
    assert.equal(list.json.length, 1);
    assert.equal(list.json[0].id, c.json.id);
    assert.equal(list.json[0].project, 'nekosub');
  } finally { s.stop(); }
});

// 6) 跨專案聚合：每張卡都帶 project
test('GET /api/cards 聚合跨專案，每張卡帶 project 欄位', async () => {
  const s = await startServer();
  try {
    await s.api('POST', '/api/projects', { id: 'golem', name: 'Golem', prefix: 'GOLEM' });
    await s.api('POST', '/api/projects', { id: 'nekosub', name: 'NekoSub', prefix: 'NEKO' });
    await s.api('POST', '/api/projects/golem/cards', { title: 'A' });
    await s.api('POST', '/api/projects/nekosub/cards', { title: 'B' });

    const all = await s.api('GET', '/api/cards');
    assert.equal(all.status, 200);
    assert.equal(all.json.length, 2);
    assert.ok(all.json.every((c) => typeof c.project === 'string' && c.project.length > 0));
    assert.deepEqual(new Set(all.json.map((c) => c.project)), new Set(['golem', 'nekosub']));
  } finally { s.stop(); }
});

// 7) 每個專案獨立流水號
test('流水號每專案獨立（GOLEM-001 與 NEKO-001 並存）', async () => {
  const s = await startServer();
  try {
    await s.api('POST', '/api/projects', { id: 'golem', name: 'Golem', prefix: 'GOLEM' });
    await s.api('POST', '/api/projects', { id: 'nekosub', name: 'NekoSub', prefix: 'NEKO' });
    const g = await s.api('POST', '/api/projects/golem/cards', { title: 'g1' });
    const n = await s.api('POST', '/api/projects/nekosub/cards', { title: 'n1' });
    assert.equal(g.json.id, 'GOLEM-001');
    assert.equal(n.json.id, 'NEKO-001');
  } finally { s.stop(); }
});

// 8) 未知專案 → 404
test('POST 到不存在的專案回 404', async () => {
  const s = await startServer();
  try {
    const r = await s.api('POST', '/api/projects/ghost/cards', { title: 'x' });
    assert.equal(r.status, 404);
  } finally { s.stop(); }
});
