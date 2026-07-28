import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { startServer } from './helper.mjs';

const CLIENT = new URL('../../../scripts/monstrare-agent.mjs', import.meta.url)
  .pathname.replace(/^\/([A-Za-z]:)/, '$1');

function runClient(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLIENT, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code) => {
      let json = null;
      try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch {}
      resolve({ code, stdout, stderr, json });
    });
  });
}

test('agent CLI 以環境變數 identity token 取得身份並認領下一張卡', async () => {
  const s = await startServer({
    token: 'admin-token',
    identities: [
      { id: 'hermes1', token: 'hermes1-token-123', roles: ['worker'] },
    ],
  });
  const env = {
    MONSTRARE_URL: s.base,
    MONSTRARE_TOKEN: 'hermes1-token-123',
  };
  try {
    const admin = { Authorization: 'Bearer admin-token' };
    await s.api(
      'POST',
      '/api/projects',
      { id: 'monstrare', name: 'Monstrare', prefix: 'MON' },
      admin,
    );
    await s.api(
      'POST',
      '/api/projects/monstrare/cards',
      { title: 'CLI task', stage: 'ready' },
      admin,
    );

    const identity = await runClient(['identity'], env);
    assert.equal(identity.code, 0);
    assert.equal(identity.json.id, 'hermes1');

    const claimed = await runClient(['next', 'monstrare'], env);
    assert.equal(claimed.code, 0);
    assert.equal(claimed.json.id, 'MON-001');
    assert.equal(claimed.json.coordination.claim.agentId, 'hermes1');

    const unauthorized = await runClient(
      ['identity'],
      { ...env, MONSTRARE_TOKEN: 'wrong-token' },
    );
    assert.equal(unauthorized.code, 1);
    assert.match(unauthorized.stderr, /401/);
  } finally { await s.stop(); }
});
