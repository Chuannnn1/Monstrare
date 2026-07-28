import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);

test('container build 先產生 Blueprint bundle，再以 non-root runtime 啟動', () => {
  const dockerfile = readFileSync(new URL('Dockerfile', root), 'utf8');
  assert.match(dockerfile, /FROM node:22-bookworm-slim AS build/);
  assert.match(dockerfile, /npm run build/);
  assert.match(dockerfile, /npm prune --omit=dev/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /HEALTHCHECK/);
});

test('Zeabur K3s manifest 鎖單 replica Recreate、PVC、health probes 與 secret env', () => {
  const manifest = readFileSync(new URL('deploy/zeabur/monstrare.yaml', root), 'utf8');
  assert.match(manifest, /replicas:\s*1/);
  assert.match(manifest, /type:\s*Recreate/);
  assert.match(manifest, /persistentVolumeClaim:/);
  assert.match(manifest, /claimName:\s*monstrare-data/);
  assert.match(manifest, /secretRef:\s*\n\s*name:\s*monstrare-secrets/);
  assert.match(manifest, /path:\s*\/api\/health/);
  assert.match(manifest, /name:\s*KANBAN_REQUIRE_READ_AUTH\s*\n\s*value:\s*"true"/);
  assert.match(manifest, /runAsNonRoot:\s*true/);
  assert.doesNotMatch(manifest, /kind:\s*Secret/);
  assert.doesNotMatch(manifest, /kind:\s*Ingress/);
});
