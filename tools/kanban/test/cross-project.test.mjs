// 跨專案看板 backend 契約測試。
// 對照設計：tools/kanban/docs/cross-project-design.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startServer } from './helper.mjs';

// 1) server 必須尊重 KANBAN_PORT / KANBAN_DATA_DIR（可測試 + 可部署的前提）
test('server honors KANBAN_PORT + KANBAN_DATA_DIR（空資料目錄啟動、/api/cards 回空陣列）', async () => {
  const s = await startServer();
  try {
    const r = await s.api('GET', '/api/cards');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, []);
  } finally { await s.stop(); }
});

// 2) 專案清單端點存在
test('GET /api/projects 回 200 + 陣列（初始為空）', async () => {
  const s = await startServer();
  try {
    const r = await s.api('GET', '/api/projects');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json), 'projects 應為陣列');
    assert.equal(r.json.length, 0);
  } finally { await s.stop(); }
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
  } finally { await s.stop(); }
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
  } finally { await s.stop(); }
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
  } finally { await s.stop(); }
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
  } finally { await s.stop(); }
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
  } finally { await s.stop(); }
});

// 8) 未知專案 → 404
test('POST 到不存在的專案回 404', async () => {
  const s = await startServer();
  try {
    const r = await s.api('POST', '/api/projects/ghost/cards', { title: 'x' });
    assert.equal(r.status, 404);
  } finally { await s.stop(); }
});

test('projects.json 損壞時回 500，POST 不得把它當空清單覆寫', async () => {
  const s = await startServer();
  try {
    const projectsFile = path.join(s.dataDir, 'projects.json');
    writeFileSync(projectsFile, '{broken', 'utf8');

    const get = await s.api('GET', '/api/projects');
    assert.equal(get.status, 500);

    const post = await s.api('POST', '/api/projects', { id: 'golem', name: 'Golem', prefix: 'GOLEM' });
    assert.equal(post.status, 500);
    assert.equal(readFileSync(projectsFile, 'utf8'), '{broken');
  } finally { await s.stop(); }
});

test('projects 與 cards 寫入採 atomic rename，不殘留暫存檔', async () => {
  const s = await startServer();
  try {
    await s.api('POST', '/api/projects', { id: 'golem', name: 'Golem', prefix: 'GOLEM' });
    const card = await s.api('POST', '/api/projects/golem/cards', { title: 'atomic write' });
    assert.equal(card.status, 201);

    const rootFiles = readdirSync(s.dataDir);
    const cardFiles = readdirSync(path.join(s.dataDir, 'cards', 'golem'));
    assert.ok(rootFiles.every((name) => !name.endsWith('.tmp')));
    assert.ok(cardFiles.every((name) => !name.endsWith('.tmp')));
    assert.equal(JSON.parse(readFileSync(path.join(s.dataDir, 'projects.json'), 'utf8'))[0].id, 'golem');
    assert.equal(JSON.parse(readFileSync(path.join(s.dataDir, 'cards', 'golem', card.json.id + '.json'), 'utf8')).id, card.json.id);
  } finally { await s.stop(); }
});

test('bearer auth 保護所有寫入；GET 維持唯讀可用', async () => {
  const s = await startServer({ token: 'test-secret' });
  try {
    assert.equal((await s.api('GET', '/api/projects')).status, 200);
    assert.equal((await s.api('POST', '/api/projects', { id: 'golem', name: 'Golem', prefix: 'GOLEM' })).status, 401);
    assert.equal((await s.api('POST', '/api/projects', { id: 'golem', name: 'Golem', prefix: 'GOLEM' }, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await s.api('POST', '/api/projects', { id: 'golem', name: 'Golem', prefix: 'GOLEM' }, { Authorization: 'Bearer test-secret' })).status, 201);
    const config = await s.api('GET', '/api/config');
    assert.equal(config.json.authRequired, true);
  } finally { await s.stop(); }
});

test('非 loopback bind 未設定 token 時拒絕啟動', async () => {
  await assert.rejects(() => startServer({ host: '0.0.0.0' }), /KANBAN_AUTH_TOKEN/);
});

test('request body 超過上限回 413', async () => {
  const s = await startServer({ maxBodyBytes: 128 });
  try {
    const result = await s.api('POST', '/api/projects', { id: 'golem', name: 'x'.repeat(256), prefix: 'GOLEM' });
    assert.equal(result.status, 413);
  } finally { await s.stop(); }
});

test('epics 以 project 隔離，legacy global endpoint 回 410', async () => {
  const s = await startServer({ token: 'test-secret' });
  const auth = { Authorization: 'Bearer test-secret' };
  try {
    await s.api('POST', '/api/projects', { id: 'golem', name: 'Golem', prefix: 'GOLEM' }, auth);
    await s.api('POST', '/api/projects', { id: 'nekosub', name: 'NekoSub', prefix: 'NEKO' }, auth);
    const put = await s.api('PUT', '/api/projects/golem/epics', { epics: [{ id: 'runtime', name: 'Runtime' }] }, auth);
    assert.equal(put.status, 200);
    assert.equal((await s.api('GET', '/api/projects/golem/epics')).json.epics.length, 1);
    assert.deepEqual((await s.api('GET', '/api/projects/nekosub/epics')).json, { epics: [] });
    assert.equal((await s.api('GET', '/api/epics')).status, 410);
  } finally { await s.stop(); }
});
