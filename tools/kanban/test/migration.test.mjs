import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = new URL('../../../scripts/migrate-kanban-data.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function fixture() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'kanban-migrate-'));
  const cardsDir = path.join(dataDir, 'cards');
  mkdirSync(cardsDir, { recursive: true });
  const cards = [
    { id: 'TASK-001', title: 'g1', epic: 'golem', dependsOn: [] },
    { id: 'TASK-002', title: 'g2', epic: 'golem', dependsOn: ['TASK-001'] },
    { id: 'TASK-003', title: 'infra', epic: 'infra', dependsOn: [] },
  ];
  for (const card of cards) {
    writeFileSync(path.join(cardsDir, card.id + '.json'), JSON.stringify(card, null, 2) + '\n', 'utf8');
  }
  return dataDir;
}

function run(dataDir, ...args) {
  return spawnSync(process.execPath, [SCRIPT, '--data-dir', dataDir, ...args], { encoding: 'utf8' });
}

test('migration 預設 dry-run：unresolved project 失敗且不寫入', () => {
  const dataDir = fixture();
  try {
    const result = run(dataDir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /infra/);
    assert.equal(existsSync(path.join(dataDir, 'projects.json')), false);
    assert.equal(existsSync(path.join(dataDir, 'cards', 'golem')), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('migration seed 四專案、重映射 id/dependsOn，apply 後仍保留 flat source', () => {
  const dataDir = fixture();
  try {
    const dryRun = run(dataDir, '--map', 'infra=monstrare');
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.equal(existsSync(path.join(dataDir, 'projects.json')), false);

    const applied = run(dataDir, '--map', 'infra=monstrare', '--apply');
    assert.equal(applied.status, 0, applied.stderr);

    const projects = JSON.parse(readFileSync(path.join(dataDir, 'projects.json'), 'utf8'));
    assert.deepEqual(projects.map((p) => p.id), ['golem', 'openclaw', 'nekosub', 'monstrare']);

    const g1 = JSON.parse(readFileSync(path.join(dataDir, 'cards', 'golem', 'GOLEM-001.json'), 'utf8'));
    const g2 = JSON.parse(readFileSync(path.join(dataDir, 'cards', 'golem', 'GOLEM-002.json'), 'utf8'));
    const mon = JSON.parse(readFileSync(path.join(dataDir, 'cards', 'monstrare', 'MON-003.json'), 'utf8'));
    assert.equal(g1.project, 'golem');
    assert.deepEqual(g2.dependsOn, ['GOLEM-001']);
    assert.equal(mon.project, 'monstrare');
    assert.equal(existsSync(path.join(dataDir, 'cards', 'TASK-001.json')), true);

    const rerun = run(dataDir, '--map', 'infra=monstrare', '--apply');
    assert.equal(rerun.status, 0, rerun.stderr);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
