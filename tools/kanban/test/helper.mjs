// 測試工具：用環境變數起一個隔離的看板 server 實例。
//
// 依賴 server.mjs 支援 KANBAN_PORT / KANBAN_HOST / KANBAN_DATA_DIR。
// v1 的 server 尚未支援這些變數，因此以下 startServer() 在 TDD red 階段
// 會 readiness timeout（server 仍綁死 4420、資料仍寫死 repo 內），
// 讓所有跨專案測試以「server 未就緒」的方式失敗——正是我們要的紅燈。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const SERVER = new URL('../server.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const READY_TIMEOUT_MS = 2500;

// 每次呼叫換一個高位埠，避免撞到正在跑的 4420 或彼此。
let portSeq = 0;
function nextPort() {
  // 41000–48999 區間，序號 + pid 低位湊出不重疊的埠
  return 41000 + ((process.pid + portSeq++ * 37) % 8000);
}

export async function startServer() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'kanban-test-'));
  const port = nextPort();
  const base = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, KANBAN_HOST: '127.0.0.1', KANBAN_PORT: String(port), KANBAN_DATA_DIR: dataDir },
    stdio: 'ignore',
    windowsHide: true,
  });

  const cleanup = () => {
    try { child.kill(); } catch {}
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break; // server 已退出（例如 EADDRINUSE）
    try {
      const r = await fetch(base + '/api/cards');
      if (r.ok) {
        return {
          base,
          dataDir,
          stop: cleanup,
          async api(method, apiPath, body) {
            const res = await fetch(base + apiPath, {
              method,
              headers: { 'Content-Type': 'application/json; charset=utf-8' },
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
      // 尚未 listen，繼續輪詢
    }
    await sleep(80);
  }

  cleanup();
  throw new Error(
    `server 未在 ${port} 就緒（server.mjs 是否已支援 KANBAN_PORT / KANBAN_DATA_DIR？）`
  );
}
