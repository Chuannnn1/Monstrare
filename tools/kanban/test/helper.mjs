// 測試工具：用 ephemeral port 與獨立 data directory 起隔離的看板 server。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const SERVER = new URL('../server.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const READY_TIMEOUT_MS = 5000;

export async function startServer(options = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'kanban-test-'));
  const host = options.host || '127.0.0.1';

  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      KANBAN_HOST: host,
      KANBAN_PORT: '0',
      KANBAN_DATA_DIR: dataDir,
      KANBAN_AUTH_TOKEN: options.token || '',
      KANBAN_IDENTITIES_JSON: JSON.stringify(options.identities || []),
      KANBAN_CLAIM_TTL_SECONDS: String(options.claimTtlSeconds || 900),
      KANBAN_REQUIRE_READ_AUTH: options.requireReadAuth ? 'true' : 'false',
      KANBAN_MAX_BODY_BYTES: String(options.maxBodyBytes || 1024 * 1024),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  let base = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) base = `http://127.0.0.1:${match[1]}`;
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const cleanup = async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      try { child.kill(); } catch {}
      await Promise.race([exited, sleep(1000)]);
    }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break; // server 已退出（例如 EADDRINUSE）
    if (base) {
      try {
        const r = await fetch(base + '/api/health');
        if (r.ok) {
          return {
            base,
            dataDir,
            stop: cleanup,
            async api(method, apiPath, body, headers = {}) {
              const res = await fetch(base + apiPath, {
                method,
                headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
                body: body === undefined ? undefined : JSON.stringify(body),
              });
              const text = await res.text();
              let json = null;
              try { json = text ? JSON.parse(text) : null; } catch {}
              return { status: res.status, json, text };
            },
          };
        }
      } catch {
        // stdout 已公布埠，但 listener 可能尚未接受連線。
      }
    }
    await sleep(80);
  }

  await cleanup();
  throw new Error(
    `server 未就緒（exitCode=${child.exitCode ?? 'running'}）` +
    (stderr.trim() ? `\nstderr:\n${stderr.trim()}` : '')
  );
}
