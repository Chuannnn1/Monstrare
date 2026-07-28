import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from './helper.mjs';

const IDENTITIES = [
  { id: 'wsl-codex', token: 'wsl-token-123456', roles: ['worker', 'reviewer'] },
  { id: 'hermes1', token: 'hermes1-token-123', roles: ['worker'] },
  { id: 'hermes2', token: 'hermes2-token-123', roles: ['worker'] },
  { id: 'hermes3', token: 'hermes3-token-123', roles: ['worker', 'reviewer'] },
];

const auth = (token) => ({ Authorization: `Bearer ${token}` });

test('health endpoint 驗證 server 與 persistent data store 可讀', async () => {
  const s = await startServer();
  try {
    const health = await s.api('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.status, 'ok');
    assert.equal(health.json.storage, 'readable');
  } finally { await s.stop(); }
});

test('deployment 可要求 read auth，但 health/config 保持可供 probe 讀取', async () => {
  const s = await startServer({
    token: 'admin-token',
    identities: IDENTITIES,
    requireReadAuth: true,
  });
  try {
    assert.equal((await s.api('GET', '/api/projects')).status, 401);
    assert.equal((await s.api('GET', '/api/health')).status, 200);
    assert.equal((await s.api('GET', '/api/config')).status, 200);
    assert.equal(
      (await s.api('GET', '/api/projects', undefined, auth('hermes1-token-123'))).status,
      200,
    );
  } finally { await s.stop(); }
});

async function seedProject(s, count = 1) {
  const admin = auth('admin-token');
  await s.api(
    'POST',
    '/api/projects',
    { id: 'monstrare', name: 'Monstrare', prefix: 'MON' },
    admin,
  );
  const cards = [];
  for (let index = 0; index < count; index += 1) {
    const created = await s.api(
      'POST',
      '/api/projects/monstrare/cards',
      { title: `Agent task ${index + 1}`, stage: 'ready' },
      admin,
    );
    cards.push(created.json);
  }
  return cards;
}

test('identity token 只能使用 agent endpoints，不能取得 admin 寫入權限', async () => {
  const s = await startServer({ token: 'admin-token', identities: IDENTITIES });
  try {
    const me = await s.api('GET', '/api/identity', undefined, auth('wsl-token-123456'));
    assert.equal(me.status, 200);
    assert.deepEqual(me.json, {
      id: 'wsl-codex',
      type: 'agent',
      roles: ['worker', 'reviewer'],
    });

    const forbidden = await s.api(
      'POST',
      '/api/projects',
      { id: 'forbidden', name: 'Forbidden', prefix: 'NO' },
      auth('wsl-token-123456'),
    );
    assert.equal(forbidden.status, 403);
    assert.equal((await s.api('GET', '/api/identity')).status, 401);
  } finally { await s.stop(); }
});

test('next claim 讓不同 agent 原子認領 ready cards，並拒絕競態重複認領', async () => {
  const s = await startServer({ token: 'admin-token', identities: IDENTITIES });
  try {
    const cards = await seedProject(s, 2);
    const [wsl, hermes1] = await Promise.all([
      s.api('POST', '/api/projects/monstrare/claims/next', {}, auth('wsl-token-123456')),
      s.api('POST', '/api/projects/monstrare/claims/next', {}, auth('hermes1-token-123')),
    ]);
    assert.equal(wsl.status, 200);
    assert.equal(hermes1.status, 200);
    assert.notEqual(wsl.json.id, hermes1.json.id);
    assert.deepEqual(new Set([wsl.json.id, hermes1.json.id]), new Set(cards.map((card) => card.id)));
    assert.equal(wsl.json.coordination.state, 'claimed');
    assert.equal(wsl.json.coordination.claim.agentId, 'wsl-codex');
    assert.equal(wsl.json.stage, 'implementing');

    const noWork = await s.api(
      'POST',
      '/api/projects/monstrare/claims/next',
      {},
      auth('hermes2-token-123'),
    );
    assert.equal(noWork.status, 404);
  } finally { await s.stop(); }
});

test('claim lease 可 heartbeat，逾時後可由另一 agent 接手', async () => {
  const s = await startServer({
    token: 'admin-token',
    identities: IDENTITIES,
    claimTtlSeconds: 1,
  });
  try {
    const [card] = await seedProject(s);
    const claimed = await s.api(
      'POST',
      `/api/projects/monstrare/cards/${card.id}/claim`,
      {},
      auth('wsl-token-123456'),
    );
    assert.equal(claimed.status, 200);
    const claimId = claimed.json.coordination.claim.id;

    const heartbeat = await s.api(
      'POST',
      `/api/projects/monstrare/cards/${card.id}/heartbeat`,
      { claimId },
      auth('wsl-token-123456'),
    );
    assert.equal(heartbeat.status, 200);
    assert.equal(heartbeat.json.coordination.claim.id, claimId);

    await sleep(1100);
    const takeover = await s.api(
      'POST',
      `/api/projects/monstrare/cards/${card.id}/claim`,
      {},
      auth('hermes1-token-123'),
    );
    assert.equal(takeover.status, 200);
    assert.equal(takeover.json.coordination.claim.agentId, 'hermes1');
    assert.notEqual(takeover.json.coordination.claim.id, claimId);
  } finally { await s.stop(); }
});

test('submission 必須有成功 checks，且實作者不得審自己的成果', async () => {
  const s = await startServer({ token: 'admin-token', identities: IDENTITIES });
  try {
    const [card] = await seedProject(s);
    const claimed = await s.api(
      'POST',
      `/api/projects/monstrare/cards/${card.id}/claim`,
      {},
      auth('wsl-token-123456'),
    );
    const claimId = claimed.json.coordination.claim.id;

    const weakSubmission = await s.api(
      'POST',
      `/api/projects/monstrare/cards/${card.id}/submit`,
      { claimId, revision: 'abc1234', summary: 'Done', checks: [] },
      auth('wsl-token-123456'),
    );
    assert.equal(weakSubmission.status, 400);

    const submitted = await s.api(
      'POST',
      `/api/projects/monstrare/cards/${card.id}/submit`,
      {
        claimId,
        revision: 'abc1234',
        summary: 'Implemented the coordination endpoint.',
        checks: [{ command: 'npm test', exitCode: 0, summary: 'all tests passed' }],
        artifacts: ['verification/report.md'],
        residual: 'Deployment still requires a production domain.',
      },
      auth('wsl-token-123456'),
    );
    assert.equal(submitted.status, 200);
    assert.equal(submitted.json.stage, 'verify');
    assert.equal(submitted.json.coordination.state, 'review_pending');
    const submissionId = submitted.json.coordination.submission.id;

    const selfReview = await s.api(
      'POST',
      `/api/projects/monstrare/cards/${card.id}/review`,
      {
        submissionId,
        verdict: 'approved',
        summary: 'Self review',
        checks: [{ command: 'npm test', exitCode: 0, summary: 'passed' }],
        findings: [],
      },
      auth('wsl-token-123456'),
    );
    assert.equal(selfReview.status, 409);

    const approved = await s.api(
      'POST',
      `/api/projects/monstrare/cards/${card.id}/review`,
      {
        submissionId,
        verdict: 'approved',
        summary: 'Independent verification passed.',
        checks: [{ command: 'npm test', exitCode: 0, summary: 'all tests passed independently' }],
        findings: [],
      },
      auth('hermes3-token-123'),
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.json.stage, 'done');
    assert.equal(approved.json.gates.test, true);
    assert.equal(approved.json.gates.code_review, true);
    assert.equal(approved.json.coordination.state, 'approved');
    assert.equal(approved.json.coordination.reviews[0].reviewerId, 'hermes3');
  } finally { await s.stop(); }
});
