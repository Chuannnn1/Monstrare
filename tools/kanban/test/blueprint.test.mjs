import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { startServer } from './helper.mjs';

function readChunkWithTimeout(reader, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SSE read timeout')), timeoutMs);
    reader.read().then(
      (result) => { clearTimeout(timer); resolve(result); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

async function readSseUntil(reader, pattern) {
  let buffer = '';
  for (let i = 0; i < 10; i += 1) {
    const chunk = await readChunkWithTimeout(reader);
    if (chunk.done) break;
    buffer += new TextDecoder().decode(chunk.value);
    if (pattern.test(buffer)) return buffer;
  }
  throw new Error('SSE event not found: ' + pattern);
}

async function createProjectAndBlueprint(s) {
  await s.api('POST', '/api/projects', { id: 'monstrare', name: 'Monstrare', prefix: 'MON' });
  return s.api('POST', '/api/projects/monstrare/blueprints', {
    id: 'startup-pitch',
    title: 'Monstrare startup pitch',
    template: 'startup-pitch',
  });
}

test('建立 project-scoped blueprint 並持久化 semantic document', async () => {
  const s = await startServer();
  try {
    const created = await createProjectAndBlueprint(s);
    assert.equal(created.status, 201);
    assert.equal(created.json.revision, 0);
    assert.equal(created.json.project, 'monstrare');
    assert.deepEqual(created.json.nodes, []);
    assert.ok(existsSync(path.join(
      s.dataDir, 'blueprints', 'monstrare', 'startup-pitch', 'blueprint.json'
    )));

    const list = await s.api('GET', '/api/projects/monstrare/blueprints');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.map((item) => item.id), ['startup-pitch']);
  } finally { await s.stop(); }
});

test('typed operation batch 建立 nodes/edge 並只增加一次 revision', async () => {
  const s = await startServer();
  try {
    await createProjectAndBlueprint(s);
    const applied = await s.api('POST', '/api/projects/monstrare/blueprints/startup-pitch/operations', {
      baseRevision: 0,
      actor: { type: 'agent', id: 'codex', model: 'gpt' },
      message: 'Draft problem and solution',
      operations: [
        {
          type: 'upsertNode',
          node: {
            id: 'problem-1', type: 'problem', title: 'Session context is fragmented',
            status: 'fact', confidence: 0.9, refs: [], linkedCardIds: [],
          },
        },
        {
          type: 'upsertNode',
          node: {
            id: 'solution-1', type: 'solution', title: 'Shared agent blueprint',
            status: 'hypothesis', confidence: 0.7, refs: [], linkedCardIds: [],
          },
        },
        {
          type: 'upsertEdge',
          edge: { id: 'edge-1', from: 'problem-1', to: 'solution-1', relation: 'leads-to', label: '' },
        },
      ],
    });
    assert.equal(applied.status, 200);
    assert.equal(applied.json.document.revision, 1);
    assert.equal(applied.json.document.nodes.length, 2);
    assert.equal(applied.json.document.edges.length, 1);
    assert.equal(applied.json.event.actor.id, 'codex');

    const revisionFile = path.join(
      s.dataDir, 'blueprints', 'monstrare', 'startup-pitch', 'revisions', '000001.json'
    );
    assert.ok(existsSync(revisionFile));
    assert.equal(JSON.parse(readFileSync(revisionFile, 'utf8')).revision, 1);
  } finally { await s.stop(); }
});

test('stale baseRevision 回 409，document 不可被覆寫', async () => {
  const s = await startServer();
  try {
    await createProjectAndBlueprint(s);
    const batch = {
      baseRevision: 0,
      actor: { type: 'agent', id: 'codex' },
      message: '',
      operations: [{
        type: 'upsertNode',
        node: { id: 'problem-1', type: 'problem', title: 'A', status: 'draft', confidence: 0.5 },
      }],
    };
    assert.equal((await s.api('POST', '/api/projects/monstrare/blueprints/startup-pitch/operations', batch)).status, 200);
    const stale = await s.api('POST', '/api/projects/monstrare/blueprints/startup-pitch/operations', batch);
    assert.equal(stale.status, 409);
    assert.equal(stale.json.currentRevision, 1);

    const current = await s.api('GET', '/api/projects/monstrare/blueprints/startup-pitch');
    assert.equal(current.json.revision, 1);
    assert.equal(current.json.nodes.length, 1);
  } finally { await s.stop(); }
});

test('archive operations 保留歷史資料，不 hard-delete node/edge', async () => {
  const s = await startServer();
  try {
    await createProjectAndBlueprint(s);
    await s.api('POST', '/api/projects/monstrare/blueprints/startup-pitch/operations', {
      baseRevision: 0,
      actor: { type: 'human', id: 'owner' },
      operations: [
        { type: 'upsertNode', node: { id: 'a', type: 'note', title: 'A' } },
        { type: 'upsertNode', node: { id: 'b', type: 'note', title: 'B' } },
        { type: 'upsertEdge', edge: { id: 'ab', from: 'a', to: 'b', relation: 'related' } },
      ],
    });
    const archived = await s.api('POST', '/api/projects/monstrare/blueprints/startup-pitch/operations', {
      baseRevision: 1,
      actor: { type: 'agent', id: 'claude' },
      operations: [
        { type: 'archiveNode', nodeId: 'a' },
        { type: 'archiveEdge', edgeId: 'ab' },
      ],
    });
    assert.equal(archived.status, 200);
    assert.equal(archived.json.document.nodes.find((node) => node.id === 'a').archived, true);
    assert.equal(archived.json.document.edges.find((edge) => edge.id === 'ab').archived, true);
  } finally { await s.stop(); }
});

test('SSE 先 replay after revision，再持續串流新 revision', async () => {
  const s = await startServer();
  const abort = new AbortController();
  try {
    await createProjectAndBlueprint(s);
    await s.api('POST', '/api/projects/monstrare/blueprints/startup-pitch/operations', {
      baseRevision: 0,
      actor: { type: 'agent', id: 'codex' },
      operations: [{ type: 'upsertNode', node: { id: 'problem-1', type: 'problem', title: 'A' } }],
    });

    const response = await fetch(
      s.base + '/api/projects/monstrare/blueprints/startup-pitch/events?after=0',
      { signal: abort.signal }
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const replay = await readSseUntil(reader, /"revision":1/);
    assert.match(replay, /event: blueprint-revision/);

    const liveWrite = await s.api('POST', '/api/projects/monstrare/blueprints/startup-pitch/operations', {
      baseRevision: 1,
      actor: { type: 'agent', id: 'claude' },
      message: 'Refine the problem',
      operations: [{ type: 'patchNode', nodeId: 'problem-1', changes: { title: 'B' } }],
    });
    assert.equal(liveWrite.status, 200);
    const live = await readSseUntil(reader, /"revision":2/);
    assert.match(live, /"id":"claude"/);
    abort.abort();
  } finally {
    abort.abort();
    await s.stop();
  }
});
