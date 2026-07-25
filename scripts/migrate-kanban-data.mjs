import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_DATA_DIR = path.resolve(import.meta.dirname, '..', 'tools', 'kanban');
const SEED_PROJECTS = [
  { id: 'golem', name: 'Golem', prefix: 'GOLEM' },
  { id: 'openclaw', name: 'OpenClaw', prefix: 'CLAW' },
  { id: 'nekosub', name: 'NekoSub', prefix: 'NEKO' },
  { id: 'monstrare', name: 'Monstrare', prefix: 'MON' },
];

function usage() {
  return '用法：node scripts/migrate-kanban-data.mjs [--data-dir PATH] [--map SOURCE=PROJECT] [--apply]';
}

function parseArgs(argv) {
  const options = { apply: false, dataDir: DEFAULT_DATA_DIR, mappings: new Map() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--data-dir') {
      if (!argv[i + 1]) throw new Error('--data-dir 需要路徑');
      options.dataDir = path.resolve(argv[++i]);
    } else if (arg === '--map') {
      const value = argv[++i] || '';
      const match = value.match(/^([^=]+)=([a-z0-9][a-z0-9-]*)$/);
      if (!match) throw new Error('--map 格式必須是 SOURCE=PROJECT');
      options.mappings.set(match[1], match[2]);
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else throw new Error('未知參數：' + arg + '\n' + usage());
  }
  return options;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`${file} 不是合法 JSON：${err.message}`);
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temp, file);
  } catch (err) {
    try { fs.unlinkSync(temp); } catch {}
    throw err;
  }
}

function mergeProjects(existing) {
  if (!Array.isArray(existing)) throw new Error('projects.json 必須是陣列');
  const projects = [...existing];
  for (const seed of SEED_PROJECTS) {
    const byId = projects.find((p) => p.id === seed.id);
    if (byId) {
      if (byId.prefix !== seed.prefix) throw new Error(`專案 ${seed.id} 的既有 prefix 與 seed 衝突`);
      continue;
    }
    if (projects.some((p) => p.prefix === seed.prefix)) throw new Error(`prefix ${seed.prefix} 已被其他專案使用`);
    projects.push(seed);
  }
  return projects;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function buildPlan(dataDir, mappings) {
  const projectsFile = path.join(dataDir, 'projects.json');
  const cardsDir = path.join(dataDir, 'cards');
  const projects = mergeProjects(readJson(projectsFile, []));
  const byId = new Map(projects.map((project) => [project.id, project]));
  const files = fs.existsSync(cardsDir)
    ? fs.readdirSync(cardsDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    : [];
  const planned = [];
  const unresolved = [];

  for (const entry of files) {
    const sourceFile = path.join(cardsDir, entry.name);
    const card = readJson(sourceFile);
    const sourceKey = typeof card.project === 'string' && card.project ? card.project : card.epic;
    const projectId = mappings.get(sourceKey) || (byId.has(sourceKey) ? sourceKey : null);
    const project = projectId ? byId.get(projectId) : null;
    if (!project) {
      unresolved.push(`${card.id || entry.name}: ${sourceKey || '(missing project/epic)'}`);
      continue;
    }
    const suffix = typeof card.id === 'string' ? card.id.match(/-(\d+)$/) : null;
    if (!suffix || Number(suffix[1]) < 1) throw new Error(`${entry.name}: id 必須以正整數流水號結尾`);
    const id = `${project.prefix}-${String(Number(suffix[1])).padStart(3, '0')}`;
    planned.push({ sourceFile, sourceId: card.id, project, card, id });
  }
  if (unresolved.length) {
    throw new Error('以下卡片無法判定專案，請用 --map SOURCE=PROJECT：\n' + unresolved.join('\n'));
  }

  const bySourceId = new Map(planned.map((item) => [item.sourceId, item]));
  const destinations = new Set();
  for (const item of planned) {
    const destination = path.join(cardsDir, item.project.id, item.id + '.json');
    if (destinations.has(destination)) throw new Error(`migration destination 衝突：${destination}`);
    destinations.add(destination);
    const dependsOn = Array.isArray(item.card.dependsOn) ? item.card.dependsOn.map((oldId) => {
      const dependency = bySourceId.get(oldId);
      if (!dependency) throw new Error(`${item.sourceId}: 找不到 dependency ${oldId}`);
      if (dependency.project.id !== item.project.id) throw new Error(`${item.sourceId}: 不支援跨專案 dependency ${oldId}`);
      return dependency.id;
    }) : [];
    item.destination = destination;
    item.output = { ...item.card, id: item.id, project: item.project.id, dependsOn };
    if (fs.existsSync(destination) && !sameJson(readJson(destination), item.output)) {
      throw new Error(`destination 已存在且內容不同：${destination}`);
    }
  }
  return { projectsFile, projects, planned };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = buildPlan(options.dataDir, options.mappings);
  console.log(`[migration] ${options.apply ? 'apply' : 'dry-run'}：${plan.planned.length} 張 flat cards`);
  for (const item of plan.planned) {
    console.log(`[migration] ${item.sourceId} -> ${item.project.id}/${item.id}`);
  }
  if (!options.apply) {
    console.log('[migration] 未寫入；確認後加 --apply。');
    return;
  }
  atomicWriteJson(plan.projectsFile, plan.projects);
  for (const item of plan.planned) {
    if (!fs.existsSync(item.destination)) atomicWriteJson(item.destination, item.output);
  }
  console.log('[migration] 完成；原始 flat cards 保留未刪除。');
}

try {
  main();
} catch (err) {
  console.error('[migration] ' + err.message);
  process.exitCode = 1;
}
