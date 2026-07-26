/**
 * 治理看板 — 零依賴本地 / 可部署 server（跨專案版）
 *
 * 啟動：node tools/kanban/server.mjs（或 npm run kanban）
 * 環境變數：
 *   KANBAN_HOST      預設 127.0.0.1（部署到 Zeabur 設 0.0.0.0）
 *   KANBAN_PORT      預設 4420
 *   KANBAN_DATA_DIR  預設 server.mjs 所在目錄；放 projects.json 與 cards/
 *   KANBAN_AUTH_TOKEN 對外 bind 必填；保護所有寫入 API
 *   KANBAN_MAX_BODY_BYTES 預設 1048576
 * 資料：projects.json + cards/<projectId>/ + epics/<projectId>.json
 *       + blueprints/<projectId>/<blueprintId>/
 *   （一卡一 JSON 檔；每張卡帶 project 欄位）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { execSync } from 'node:child_process';

const ROOT = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);

const HOST = process.env.KANBAN_HOST || '127.0.0.1';
const PORT = (() => {
  if (process.env.KANBAN_PORT === undefined) return 4420;
  const value = Number(process.env.KANBAN_PORT);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error('KANBAN_PORT 必須是 0 到 65535 的整數');
  }
  return value;
})();
const DATA_DIR = process.env.KANBAN_DATA_DIR || ROOT;
const AUTH_TOKEN = process.env.KANBAN_AUTH_TOKEN || '';
const MAX_BODY_BYTES = (() => {
  const value = Number(process.env.KANBAN_MAX_BODY_BYTES || 1024 * 1024);
  if (!Number.isInteger(value) || value < 1) throw new Error('KANBAN_MAX_BODY_BYTES 必須是正整數');
  return value;
})();

if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && !AUTH_TOKEN) {
  throw new Error('非 loopback KANBAN_HOST 必須設定 KANBAN_AUTH_TOKEN');
}

const CARDS_DIR = path.join(DATA_DIR, 'cards');
const PROJECTS_JSON = path.join(DATA_DIR, 'projects.json');
const EPICS_DIR = path.join(DATA_DIR, 'epics');
const BLUEPRINTS_DIR = path.join(DATA_DIR, 'blueprints');
const INDEX_HTML = path.join(ROOT, 'index.html'); // 靜態資產隨程式碼走，不在 DATA_DIR
const PUBLIC_DIR = path.join(ROOT, 'public');
const EXCALIDRAW_ASSETS_DIR = path.resolve(
  ROOT,
  '../../node_modules/@excalidraw/excalidraw/dist/excalidraw-assets',
);

fs.mkdirSync(CARDS_DIR, { recursive: true });
fs.mkdirSync(BLUEPRINTS_DIR, { recursive: true });

// 專案 id 與卡片 prefix 的格式
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const PREFIX_RE = /^[A-Z][A-Z0-9]*$/;
const BLUEPRINT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const ENTITY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const cardIdRe = (prefix) => new RegExp('^' + prefix + '-\\d{3,}$');

// 新卡片 owner 與看板留言作者的預設值：取本機 git 身分（這個看板本來就以
// git 為同步機制），沒有 git 或沒設 user.name 時留空字串（未指派）。
const DEFAULT_OWNER = (() => {
  try {
    return execSync('git config user.name', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
})();

const STAGES = ['backlog', 'blocked', 'ready', 'implementing', 'verify', 'done'];
const ADVANCED_STAGES = ['ready', 'implementing', 'verify', 'done'];
const RISKS = ['low', 'medium', 'high'];
const TRACKS = ['frontend', 'backend', 'integration', 'n/a'];
const READINESS_KEYS = [
  'problem_clear', 'non_goals_clear', 'acceptance_testable', 'files_known',
  'scope_defined', 'verification_contract', 'human_approval_recorded'
];
const GATE_KEYS = ['product', 'ui', 'architecture', 'security', 'test', 'code_review'];
const LINK_KEYS = ['featureSpec', 'screenSpec', 'mockupDecision', 'taskCard', 'verificationReport', 'pr'];
const BLUEPRINT_NODE_TYPES = [
  'problem', 'customer', 'insight', 'solution', 'value', 'distribution',
  'business-model', 'moat', 'risk', 'experiment', 'component', 'decision',
  'task', 'note'
];
const BLUEPRINT_NODE_STATUSES = ['draft', 'fact', 'assumption', 'hypothesis', 'decision'];
const BLUEPRINT_EDGE_RELATIONS = [
  'supports', 'contradicts', 'depends-on', 'leads-to', 'validates', 'contains', 'related'
];
const BLUEPRINT_OPERATION_TYPES = [
  'upsertNode', 'patchNode', 'archiveNode', 'upsertEdge', 'archiveEdge'
];
const blueprintStreams = new Map();

/* ── helpers ── */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function staticContentType(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  }[ext] || 'application/octet-stream';
}

function sendStaticFile(req, res, root, relativePath, cacheControl = 'public, max-age=3600') {
  let decoded;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch {
    throw new ApiError(400, 'asset path 格式不合法');
  }
  if (!decoded || decoded.includes('\0') || decoded.split('/').includes('..')) {
    throw new ApiError(400, 'asset path 格式不合法');
  }
  const file = path.resolve(root, decoded);
  const rootPrefix = path.resolve(root) + path.sep;
  if (!file.startsWith(rootPrefix)) throw new ApiError(400, 'asset path 格式不合法');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') throw new ApiError(404, 'asset 不存在');
    throw err;
  }
  if (!stat.isFile()) throw new ApiError(404, 'asset 不存在');
  res.writeHead(200, {
    'Content-Type': staticContentType(file),
    'Content-Length': stat.size,
    'Cache-Control': cacheControl,
  });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new PayloadTooLargeError());
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

class InvalidBodyError extends Error {}
class PayloadTooLargeError extends Error {}
class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function parseBody(body) {
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new InvalidBodyError(err.message);
  }
}

function hasValidBearerToken(req) {
  if (!AUTH_TOKEN) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(AUTH_TOKEN);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temp, file);
    renamed = true;
  } finally {
    if (!renamed) {
      try { fs.unlinkSync(temp); } catch {}
    }
  }
}

/** 卡片驗證。prefix 為所屬專案的 id 前綴，決定 id 與 dependsOn 元素的格式。 */
function validateCard(c, prefix) {
  const idRe = cardIdRe(prefix);
  if (!isPlainObject(c)) return 'card 必須是 object';
  if (typeof c.id !== 'string' || !idRe.test(c.id)) return 'id 必須符合 ^' + prefix + '-\\d{3,}$';
  if (typeof c.project !== 'string' || c.project === '') return 'project 必須是非空字串';
  if (typeof c.title !== 'string' || c.title.trim() === '') return 'title 必須是非空字串';
  if (typeof c.content !== 'string') return 'content 必須是字串';
  if (!STAGES.includes(c.stage)) return 'stage 只允許 ' + STAGES.join('/');
  if (!RISKS.includes(c.risk)) return 'risk 只允許 ' + RISKS.join('/');
  if (typeof c.owner !== 'string') return 'owner 必須是字串';
  if (typeof c.agent !== 'string') return 'agent 必須是字串';
  if (typeof c.approvalRequired !== 'boolean') return 'approvalRequired 必須是 boolean';
  if (typeof c.createdAt !== 'string') return 'createdAt 必須是字串';
  if (!Number.isInteger(c.order) || c.order < 1) return 'order 必須是 >= 1 的整數';
  if (typeof c.epic !== 'string') return 'epic 必須是字串';
  if (typeof c.userStory !== 'string') return 'userStory 必須是字串';
  if (!TRACKS.includes(c.track)) return 'track 只允許 ' + TRACKS.join('/');
  if (!Array.isArray(c.dependsOn) || c.dependsOn.some((x) => typeof x !== 'string' || !idRe.test(x))) {
    return 'dependsOn 必須是字串陣列，且每個元素需符合同專案 id 格式 ^' + prefix + '-\\d{3,}$';
  }
  if (c.dependsOn.includes(c.id)) return 'dependsOn 不可包含自己的 id';

  if (!isPlainObject(c.readiness)) return 'readiness 必須是 object';
  for (const k of READINESS_KEYS) {
    if (typeof c.readiness[k] !== 'boolean') return 'readiness.' + k + ' 必須是 boolean';
  }
  if (!isPlainObject(c.gates)) return 'gates 必須是 object';
  for (const k of GATE_KEYS) {
    if (typeof c.gates[k] !== 'boolean') return 'gates.' + k + ' 必須是 boolean';
  }
  if (!isPlainObject(c.links)) return 'links 必須是 object';
  for (const k of LINK_KEYS) {
    if (typeof c.links[k] !== 'string') return 'links.' + k + ' 必須是字串';
  }
  if (!Array.isArray(c.refs) || c.refs.some((r) => typeof r !== 'string')) {
    return 'refs 必須是字串陣列';
  }
  if (!isPlainObject(c.evidence)) return 'evidence 必須是 object';
  if (!Array.isArray(c.evidence.commands) || c.evidence.commands.some((x) => typeof x !== 'string')) {
    return 'evidence.commands 必須是字串陣列';
  }
  if (!Array.isArray(c.evidence.findings) || c.evidence.findings.some((x) => typeof x !== 'string')) {
    return 'evidence.findings 必須是字串陣列';
  }
  if (typeof c.evidence.residual !== 'string') return 'evidence.residual 必須是字串';
  if (!Array.isArray(c.comments)) return 'comments 必須是陣列';
  for (const item of c.comments) {
    if (!isPlainObject(item)) return 'comments 每項必須是 { name, time, text } object';
    if (typeof item.name !== 'string') return 'comments[].name 必須是字串';
    if (typeof item.time !== 'string') return 'comments[].time 必須是字串';
    if (typeof item.text !== 'string') return 'comments[].text 必須是字串';
  }
  return null;
}

function defaultObj(keys, value) {
  const o = {};
  for (const k of keys) o[k] = value;
  return o;
}

/** 舊資料 / 精簡 client 相容：缺少的欄位補預設值（in-place） */
function fillDefaults(c) {
  if (!isPlainObject(c)) return c;
  if (c.project === undefined) c.project = '';
  if (c.content === undefined) c.content = '';
  if (c.agent === undefined) c.agent = '';
  if (c.approvalRequired === undefined) c.approvalRequired = false;
  if (c.epic === undefined) c.epic = '';
  if (c.userStory === undefined) c.userStory = '';
  if (c.track === undefined) c.track = 'n/a';
  if (!Array.isArray(c.dependsOn)) c.dependsOn = [];
  if (!isPlainObject(c.readiness)) c.readiness = defaultObj(READINESS_KEYS, false);
  else for (const k of READINESS_KEYS) if (c.readiness[k] === undefined) c.readiness[k] = false;
  if (!isPlainObject(c.gates)) c.gates = defaultObj(GATE_KEYS, false);
  else for (const k of GATE_KEYS) if (c.gates[k] === undefined) c.gates[k] = false;
  if (!isPlainObject(c.links)) c.links = defaultObj(LINK_KEYS, '');
  else for (const k of LINK_KEYS) if (c.links[k] === undefined) c.links[k] = '';
  if (!Array.isArray(c.refs)) c.refs = [];
  if (!isPlainObject(c.evidence)) c.evidence = { commands: [], findings: [], residual: '' };
  if (!Array.isArray(c.comments)) c.comments = [];
  return c;
}

/** 固定 key 順序寫檔到 cards/<pid>/，2 空格縮排 + 結尾換行，減少 diff 噪音 */
function writeCard(c, pid) {
  const normalized = {
    id: c.id,
    project: c.project,
    title: c.title,
    content: c.content,
    stage: c.stage,
    risk: c.risk,
    owner: c.owner,
    agent: c.agent,
    approvalRequired: c.approvalRequired,
    createdAt: c.createdAt,
    epic: c.epic,
    userStory: c.userStory,
    track: c.track,
    dependsOn: c.dependsOn,
    order: c.order,
    readiness: c.readiness,
    gates: c.gates,
    links: c.links,
    refs: c.refs,
    evidence: c.evidence,
    comments: c.comments
  };
  const dir = path.join(CARDS_DIR, pid);
  atomicWriteJson(path.join(dir, c.id + '.json'), normalized);
}

/* ── projects ── */

function readProjects() {
  const list = readJsonFile(PROJECTS_JSON, []);
  if (!Array.isArray(list)) throw new Error('projects.json 必須是陣列');
  return list;
}

function writeProjects(list) {
  atomicWriteJson(PROJECTS_JSON, list);
}

function getProject(pid) {
  return readProjects().find((p) => p.id === pid) || null;
}

/** 讀單一專案的卡片，排序後回傳；project 欄位以目錄為準（權威來源） */
function readProjectCards(project) {
  const dir = path.join(CARDS_DIR, project.id);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const cards = files.map((f) => {
    const c = fillDefaults(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    c.project = project.id;
    return c;
  });
  cards.sort((a, b) =>
    STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) ||
    a.order - b.order ||
    a.id.localeCompare(b.id)
  );
  return cards;
}

/** 跨專案聚合，每張卡都帶 project 欄位 */
function readAllCards() {
  const all = [];
  for (const p of readProjects()) all.push(...readProjectCards(p));
  return all;
}

/**
 * 從 startId 沿 dependsOn 邊做 DFS，找出第一個可達的循環。
 * cardMap 必須包含這次請求裡「即將寫入」的最新版本（覆蓋掉舊檔內容）。
 * 回傳循環路徑（含重複的起點，方便顯示 "A -> B -> A"），沒有循環回傳 null。
 */
function detectCycle(startId, cardMap) {
  const stack = [];
  const onPath = new Set();
  function visit(id) {
    if (onPath.has(id)) return stack.slice(stack.indexOf(id)).concat(id);
    const card = cardMap.get(id);
    if (!card || !Array.isArray(card.dependsOn)) return null;
    stack.push(id);
    onPath.add(id);
    for (const dep of card.dependsOn) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    onPath.delete(id);
    return null;
  }
  return visit(startId);
}

/**
 * 檢查一張卡的 dependsOn（限縮在同一專案內）：參照是否存在、是否形成循環、
 * 若要推進到 ready/implementing/verify/done，前置任務是否皆已 done。
 * cardMap 必須包含這次請求裡「即將寫入」的最新版本。回傳錯誤字串，沒有問題回傳 null。
 */
function checkDependsOn(card, cardMap) {
  const missing = card.dependsOn.filter((depId) => !cardMap.has(depId));
  if (missing.length) return card.id + ': dependsOn 參照到不存在的卡片（限同專案）：' + missing.join(', ');

  const cycle = detectCycle(card.id, cardMap);
  if (cycle) return card.id + ': 偵測到循環依賴：' + cycle.join(' -> ');

  if (ADVANCED_STAGES.includes(card.stage)) {
    const unmet = card.dependsOn.map((depId) => cardMap.get(depId)).filter((dep) => dep.stage !== 'done');
    if (unmet.length) {
      return (
        card.id + ': 前置任務尚未完成（' +
        unmet.map((d) => d.id + ' ' + d.title).join('、') +
        '），無法推進到 ' + card.stage
      );
    }
  }
  return null;
}

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/* ── blueprints ── */

function blueprintDir(project, blueprintId) {
  return path.join(BLUEPRINTS_DIR, project.id, blueprintId);
}

function blueprintFile(project, blueprintId) {
  return path.join(blueprintDir(project, blueprintId), 'blueprint.json');
}

function blueprintRevisionDir(project, blueprintId) {
  return path.join(blueprintDir(project, blueprintId), 'revisions');
}

function readBlueprintEvents(project, blueprintId, afterRevision = -1) {
  const dir = blueprintRevisionDir(project, blueprintId);
  let files;
  try {
    files = fs.readdirSync(dir).filter((file) => /^\d{6}\.json$/.test(file)).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return files
    .map((file) => readJsonFile(path.join(dir, file), null))
    .filter((event) => event && Number.isInteger(event.revision) && event.revision > afterRevision);
}

function readBlueprint(project, blueprintId) {
  const current = readJsonFile(blueprintFile(project, blueprintId), null);
  if (!current) return null;
  const revisions = readBlueprintEvents(project, blueprintId, current.revision);
  const latest = revisions.at(-1);
  return latest && latest.document && latest.document.revision > current.revision
    ? latest.document
    : current;
}

function listBlueprints(project) {
  const projectDir = path.join(BLUEPRINTS_DIR, project.id);
  let entries;
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isDirectory() && BLUEPRINT_ID_RE.test(entry.name))
    .map((entry) => readBlueprint(project, entry.name))
    .filter(Boolean)
    .map((document) => ({
      id: document.id,
      project: document.project,
      title: document.title,
      template: document.template,
      revision: document.revision,
      updatedAt: document.updatedAt,
      nodeCount: document.nodes.length,
      edgeCount: document.edges.length,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

function validateStringArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ApiError(400, field + ' 必須是字串陣列');
  }
  return [...value];
}

function validateBlueprintLayout(value) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) throw new ApiError(400, 'node.layout 必須是 object 或 null');
  const layout = {};
  for (const key of ['x', 'y', 'w', 'h']) {
    if (!Number.isFinite(value[key])) throw new ApiError(400, `node.layout.${key} 必須是有限數字`);
    layout[key] = value[key];
  }
  if (layout.w <= 0 || layout.h <= 0) throw new ApiError(400, 'node.layout.w/h 必須大於 0');
  return layout;
}

function normalizeBlueprintNode(input, actorId, existing = null) {
  if (!isPlainObject(input)) throw new ApiError(400, 'node 必須是 object');
  if (typeof input.id !== 'string' || !ENTITY_ID_RE.test(input.id)) {
    throw new ApiError(400, 'node.id 格式不合法');
  }
  if (!BLUEPRINT_NODE_TYPES.includes(input.type)) {
    throw new ApiError(400, 'node.type 不支援：' + input.type);
  }
  if (typeof input.title !== 'string' || !input.title.trim()) {
    throw new ApiError(400, 'node.title 必須是非空字串');
  }
  const status = input.status ?? existing?.status ?? 'draft';
  if (!BLUEPRINT_NODE_STATUSES.includes(status)) {
    throw new ApiError(400, 'node.status 不支援：' + status);
  }
  const confidence = Object.hasOwn(input, 'confidence')
    ? input.confidence
    : (existing?.confidence ?? null);
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new ApiError(400, 'node.confidence 必須是 0..1 或 null');
  }
  const body = input.body ?? existing?.body ?? '';
  if (typeof body !== 'string') throw new ApiError(400, 'node.body 必須是字串');
  return {
    id: input.id,
    type: input.type,
    title: input.title.trim(),
    body,
    status,
    confidence,
    refs: validateStringArray(input.refs ?? existing?.refs, 'node.refs'),
    linkedCardIds: validateStringArray(input.linkedCardIds ?? existing?.linkedCardIds, 'node.linkedCardIds'),
    layout: validateBlueprintLayout(
      Object.hasOwn(input, 'layout') ? input.layout : existing?.layout
    ),
    createdBy: existing?.createdBy || actorId,
    updatedBy: actorId,
    archived: input.archived ?? existing?.archived ?? false,
  };
}

function normalizeBlueprintEdge(input, document, existing = null) {
  if (!isPlainObject(input)) throw new ApiError(400, 'edge 必須是 object');
  if (typeof input.id !== 'string' || !ENTITY_ID_RE.test(input.id)) {
    throw new ApiError(400, 'edge.id 格式不合法');
  }
  if (typeof input.from !== 'string' || typeof input.to !== 'string') {
    throw new ApiError(400, 'edge.from/to 必須是字串');
  }
  if (input.from === input.to) throw new ApiError(400, 'edge 不可連到自己');
  if (!document.nodes.some((node) => node.id === input.from) || !document.nodes.some((node) => node.id === input.to)) {
    throw new ApiError(400, 'edge.from/to 必須參照已存在 node');
  }
  if (!BLUEPRINT_EDGE_RELATIONS.includes(input.relation)) {
    throw new ApiError(400, 'edge.relation 不支援：' + input.relation);
  }
  const label = input.label ?? existing?.label ?? '';
  if (typeof label !== 'string') throw new ApiError(400, 'edge.label 必須是字串');
  return {
    id: input.id,
    from: input.from,
    to: input.to,
    relation: input.relation,
    label,
    archived: input.archived ?? existing?.archived ?? false,
  };
}

function applyBlueprintOperation(document, operation, actorId) {
  if (!isPlainObject(operation) || !BLUEPRINT_OPERATION_TYPES.includes(operation.type)) {
    throw new ApiError(400, 'operation.type 不支援');
  }
  if (operation.type === 'upsertNode') {
    const existingIndex = document.nodes.findIndex((node) => node.id === operation.node?.id);
    const existing = existingIndex >= 0 ? document.nodes[existingIndex] : null;
    const normalized = normalizeBlueprintNode(operation.node, actorId, existing);
    if (existingIndex >= 0) document.nodes[existingIndex] = normalized;
    else document.nodes.push(normalized);
    return;
  }
  if (operation.type === 'patchNode') {
    const index = document.nodes.findIndex((node) => node.id === operation.nodeId);
    if (index < 0) throw new ApiError(400, 'patchNode 找不到 node：' + operation.nodeId);
    if (!isPlainObject(operation.changes)) throw new ApiError(400, 'patchNode.changes 必須是 object');
    const allowed = new Set(['type', 'title', 'body', 'status', 'confidence', 'refs', 'linkedCardIds', 'layout']);
    const invalid = Object.keys(operation.changes).filter((key) => !allowed.has(key));
    if (invalid.length) throw new ApiError(400, 'patchNode 不允許欄位：' + invalid.join(', '));
    const merged = { ...document.nodes[index], ...operation.changes, id: operation.nodeId };
    document.nodes[index] = normalizeBlueprintNode(merged, actorId, document.nodes[index]);
    return;
  }
  if (operation.type === 'archiveNode') {
    const node = document.nodes.find((item) => item.id === operation.nodeId);
    if (!node) throw new ApiError(400, 'archiveNode 找不到 node：' + operation.nodeId);
    node.archived = true;
    node.updatedBy = actorId;
    return;
  }
  if (operation.type === 'upsertEdge') {
    const existingIndex = document.edges.findIndex((edge) => edge.id === operation.edge?.id);
    const existing = existingIndex >= 0 ? document.edges[existingIndex] : null;
    const normalized = normalizeBlueprintEdge(operation.edge, document, existing);
    if (existingIndex >= 0) document.edges[existingIndex] = normalized;
    else document.edges.push(normalized);
    return;
  }
  const edge = document.edges.find((item) => item.id === operation.edgeId);
  if (!edge) throw new ApiError(400, 'archiveEdge 找不到 edge：' + operation.edgeId);
  edge.archived = true;
}

function publicBlueprintEvent(storedEvent) {
  const { document: _document, ...event } = storedEvent;
  return event;
}

function streamKey(project, blueprintId) {
  return project.id + '/' + blueprintId;
}

function writeBlueprintSse(res, event) {
  res.write('event: blueprint-revision\n');
  res.write('id: ' + event.revision + '\n');
  res.write('data: ' + JSON.stringify(event) + '\n\n');
}

function broadcastBlueprintEvent(project, blueprintId, event) {
  const clients = blueprintStreams.get(streamKey(project, blueprintId));
  if (!clients) return;
  for (const res of clients) writeBlueprintSse(res, event);
}

function handleCreateBlueprint(res, project, body) {
  const input = parseBody(body);
  if (!isPlainObject(input)) throw new ApiError(400, 'body 必須是 object');
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const template = typeof input.template === 'string' ? input.template.trim() : '';
  if (!BLUEPRINT_ID_RE.test(id)) throw new ApiError(400, 'blueprint id 格式不合法');
  if (!title) throw new ApiError(400, 'title 必須是非空字串');
  if (!template) throw new ApiError(400, 'template 必須是非空字串');
  if (readBlueprint(project, id)) throw new ApiError(409, 'blueprint 已存在：' + id);
  const now = new Date().toISOString();
  const document = {
    id,
    project: project.id,
    title,
    template,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    nodes: [],
    edges: [],
  };
  atomicWriteJson(blueprintFile(project, id), document);
  sendJson(res, 201, document);
}

function commitBlueprintOperations(project, blueprintId, input) {
  if (!isPlainObject(input)) throw new ApiError(400, 'body 必須是 object');
  const current = readBlueprint(project, blueprintId);
  if (!current) throw new ApiError(404, 'blueprint 不存在：' + blueprintId);
  if (!Number.isInteger(input.baseRevision) || input.baseRevision !== current.revision) {
    throw new ApiError(409, 'baseRevision 已過期', { currentRevision: current.revision });
  }
  if (!isPlainObject(input.actor) || !['agent', 'human'].includes(input.actor.type)) {
    throw new ApiError(400, 'actor.type 必須是 agent 或 human');
  }
  if (typeof input.actor.id !== 'string' || !ENTITY_ID_RE.test(input.actor.id)) {
    throw new ApiError(400, 'actor.id 格式不合法');
  }
  if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 50) {
    throw new ApiError(400, 'operations 必須包含 1..50 個操作');
  }
  if (input.message !== undefined && typeof input.message !== 'string') {
    throw new ApiError(400, 'message 必須是字串');
  }

  const next = structuredClone(current);
  for (const operation of input.operations) applyBlueprintOperation(next, operation, input.actor.id);
  next.revision = current.revision + 1;
  next.updatedAt = new Date().toISOString();
  const storedEvent = {
    revision: next.revision,
    project: project.id,
    blueprintId,
    timestamp: next.updatedAt,
    actor: {
      type: input.actor.type,
      id: input.actor.id,
      ...(typeof input.actor.model === 'string' && input.actor.model ? { model: input.actor.model } : {}),
    },
    message: input.message || '',
    operations: structuredClone(input.operations),
    document: next,
  };
  const revisionFile = path.join(
    blueprintRevisionDir(project, blueprintId),
    String(next.revision).padStart(6, '0') + '.json'
  );
  atomicWriteJson(revisionFile, storedEvent);
  atomicWriteJson(blueprintFile(project, blueprintId), next);
  const event = publicBlueprintEvent(storedEvent);
  broadcastBlueprintEvent(project, blueprintId, event);
  return { document: next, event };
}

function handleBlueprintOperations(res, project, blueprintId, body) {
  const input = parseBody(body);
  sendJson(res, 200, commitBlueprintOperations(project, blueprintId, input));
}

function blueprintDiscussionsFile(project, blueprintId) {
  return path.join(blueprintDir(project, blueprintId), 'discussions.json');
}

function readBlueprintDiscussions(project, blueprintId) {
  const list = readJsonFile(blueprintDiscussionsFile(project, blueprintId), []);
  if (!Array.isArray(list)) throw new Error('discussions.json 必須是陣列');
  return list;
}

function handleCreateBlueprintDiscussion(res, project, blueprintId, body) {
  if (!readBlueprint(project, blueprintId)) throw new ApiError(404, 'blueprint 不存在：' + blueprintId);
  const input = parseBody(body);
  if (!isPlainObject(input) || !isPlainObject(input.author)) throw new ApiError(400, 'author 必須是 object');
  if (!['agent', 'human'].includes(input.author.type) || typeof input.author.id !== 'string' || !ENTITY_ID_RE.test(input.author.id)) {
    throw new ApiError(400, 'author 必須包含有效的 type/id');
  }
  if (typeof input.text !== 'string' || !input.text.trim()) throw new ApiError(400, 'text 必須是非空字串');
  const nodeIds = validateStringArray(input.nodeIds, 'nodeIds');
  const document = readBlueprint(project, blueprintId);
  const missing = nodeIds.filter((id) => !document.nodes.some((node) => node.id === id));
  if (missing.length) throw new ApiError(400, 'nodeIds 不存在：' + missing.join(', '));
  const message = {
    id: 'msg-' + randomUUID(),
    author: {
      type: input.author.type,
      id: input.author.id,
      ...(typeof input.author.model === 'string' && input.author.model ? { model: input.author.model } : {}),
    },
    nodeIds,
    text: input.text.trim(),
    createdAt: new Date().toISOString(),
  };
  const discussions = readBlueprintDiscussions(project, blueprintId);
  discussions.push(message);
  atomicWriteJson(blueprintDiscussionsFile(project, blueprintId), discussions);
  sendJson(res, 201, message);
}

function blueprintProposalsDir(project, blueprintId) {
  return path.join(blueprintDir(project, blueprintId), 'proposals');
}

function blueprintProposalFile(project, blueprintId, proposalId) {
  return path.join(blueprintProposalsDir(project, blueprintId), proposalId + '.json');
}

function readBlueprintProposals(project, blueprintId) {
  const dir = blueprintProposalsDir(project, blueprintId);
  let files;
  try {
    files = fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return files.map((file) => readJsonFile(path.join(dir, file), null)).filter(Boolean);
}

function handleCreateBlueprintProposal(res, project, blueprintId, body) {
  const current = readBlueprint(project, blueprintId);
  if (!current) throw new ApiError(404, 'blueprint 不存在：' + blueprintId);
  const input = parseBody(body);
  if (!isPlainObject(input)) throw new ApiError(400, 'body 必須是 object');
  if (typeof input.id !== 'string' || !ENTITY_ID_RE.test(input.id)) throw new ApiError(400, 'proposal id 格式不合法');
  if (fs.existsSync(blueprintProposalFile(project, blueprintId, input.id))) {
    throw new ApiError(409, 'proposal 已存在：' + input.id);
  }
  if (input.baseRevision !== current.revision) {
    throw new ApiError(409, 'baseRevision 已過期', { currentRevision: current.revision });
  }
  if (!isPlainObject(input.actor) || input.actor.type !== 'agent' || typeof input.actor.id !== 'string' || !ENTITY_ID_RE.test(input.actor.id)) {
    throw new ApiError(400, 'proposal actor 必須是有效 agent');
  }
  if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 50) {
    throw new ApiError(400, 'operations 必須包含 1..50 個操作');
  }
  const preview = structuredClone(current);
  for (const operation of input.operations) applyBlueprintOperation(preview, operation, input.actor.id);
  const proposal = {
    id: input.id,
    project: project.id,
    blueprintId,
    baseRevision: input.baseRevision,
    actor: input.actor,
    message: typeof input.message === 'string' ? input.message : '',
    operations: input.operations,
    status: 'pending',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
  };
  atomicWriteJson(blueprintProposalFile(project, blueprintId, proposal.id), proposal);
  sendJson(res, 201, proposal);
}

function handleResolveBlueprintProposal(res, project, blueprintId, proposalId, resolution, body) {
  const file = blueprintProposalFile(project, blueprintId, proposalId);
  const proposal = readJsonFile(file, null);
  if (!proposal) throw new ApiError(404, 'proposal 不存在：' + proposalId);
  if (proposal.status !== 'pending') throw new ApiError(409, 'proposal 已處理：' + proposal.status);
  const input = parseBody(body);
  if (
    !isPlainObject(input) ||
    !isPlainObject(input.actor) ||
    input.actor.type !== 'human' ||
    typeof input.actor.id !== 'string' ||
    !ENTITY_ID_RE.test(input.actor.id)
  ) {
    throw new ApiError(400, 'resolution actor 必須是有效 human');
  }
  let result = null;
  if (resolution === 'accepted') {
    result = commitBlueprintOperations(project, blueprintId, {
      baseRevision: proposal.baseRevision,
      actor: proposal.actor,
      message: proposal.message,
      operations: proposal.operations,
    });
  }
  proposal.status = resolution;
  proposal.resolvedAt = new Date().toISOString();
  proposal.resolvedBy = input.actor;
  atomicWriteJson(file, proposal);
  sendJson(res, 200, { proposal, ...(result || {}) });
}

function handleMaterializeBlueprintTasks(res, project, blueprintId, body) {
  const document = readBlueprint(project, blueprintId);
  if (!document) throw new ApiError(404, 'blueprint 不存在：' + blueprintId);
  const input = parseBody(body);
  if (!isPlainObject(input) || !isPlainObject(input.actor)) throw new ApiError(400, 'body/actor 格式不合法');
  if (!['agent', 'human'].includes(input.actor.type) || typeof input.actor.id !== 'string' || !ENTITY_ID_RE.test(input.actor.id)) {
    throw new ApiError(400, 'actor 格式不合法');
  }
  const nodeIds = validateStringArray(input.nodeIds, 'nodeIds');
  if (!nodeIds.length || nodeIds.length > 20) throw new ApiError(400, 'nodeIds 必須包含 1..20 項');
  const nodes = nodeIds.map((id) => document.nodes.find((node) => node.id === id));
  if (nodes.some((node) => !node || node.archived || !['task', 'experiment'].includes(node.type))) {
    throw new ApiError(400, '只能 materialize 未封存的 task/experiment nodes');
  }
  if (nodes.some((node) => node.linkedCardIds.length)) {
    throw new ApiError(409, '至少一個 node 已連結 Kanban card');
  }
  const cards = nodes.map((node) => createCardRecord(project, {
    title: node.title,
    content: node.body,
    stage: 'backlog',
    risk: node.type === 'experiment' ? 'medium' : 'low',
    owner: typeof input.owner === 'string' ? input.owner : DEFAULT_OWNER,
    agent: typeof input.agent === 'string' ? input.agent : '',
    epic: document.title,
    refs: node.refs,
  }));
  const operations = nodes.map((node, index) => ({
    type: 'patchNode',
    nodeId: node.id,
    changes: { linkedCardIds: [...node.linkedCardIds, cards[index].id] },
  }));
  const committed = commitBlueprintOperations(project, blueprintId, {
    baseRevision: document.revision,
    actor: input.actor,
    message: 'Materialize task nodes to Kanban',
    operations,
  });
  sendJson(res, 201, { cards, document: committed.document, event: committed.event });
}

function handleBlueprintEvents(req, res, project, blueprintId, searchParams) {
  const document = readBlueprint(project, blueprintId);
  if (!document) throw new ApiError(404, 'blueprint 不存在：' + blueprintId);
  const rawAfter = searchParams.get('after') || '0';
  const after = Number(rawAfter);
  if (!Number.isInteger(after) || after < 0) throw new ApiError(400, 'after 必須是非負整數');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  for (const storedEvent of readBlueprintEvents(project, blueprintId, after)) {
    writeBlueprintSse(res, publicBlueprintEvent(storedEvent));
  }

  const key = streamKey(project, blueprintId);
  if (!blueprintStreams.has(key)) blueprintStreams.set(key, new Set());
  const clients = blueprintStreams.get(key);
  clients.add(res);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  heartbeat.unref();
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    if (!clients.size) blueprintStreams.delete(key);
  });
}

/* ── route handlers ── */

function handleEpics(res, project) {
  const data = readJsonFile(path.join(EPICS_DIR, project.id + '.json'), { epics: [] });
  if (!isPlainObject(data) || !Array.isArray(data.epics)) throw new Error(`${project.id} epics 必須是 { epics: [] }`);
  sendJson(res, 200, data);
}

function handlePutEpics(res, project, body) {
  const data = parseBody(body);
  if (!isPlainObject(data) || !Array.isArray(data.epics)) {
    return sendJson(res, 400, { error: 'body 必須是 { epics: [] }' });
  }
  atomicWriteJson(path.join(EPICS_DIR, project.id + '.json'), data);
  sendJson(res, 200, data);
}

function handleCreateProject(res, body) {
  const input = parseBody(body);
  if (!isPlainObject(input)) return sendJson(res, 400, { error: 'body 必須是 object' });
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const prefix = typeof input.prefix === 'string' ? input.prefix.trim() : '';
  if (!PROJECT_ID_RE.test(id)) return sendJson(res, 400, { error: 'id 必須符合 ^[a-z0-9][a-z0-9-]*$' });
  if (name === '') return sendJson(res, 400, { error: 'name 必須是非空字串' });
  if (!PREFIX_RE.test(prefix)) return sendJson(res, 400, { error: 'prefix 必須符合 ^[A-Z][A-Z0-9]*$' });
  const projects = readProjects();
  if (projects.some((p) => p.id === id)) return sendJson(res, 400, { error: '專案 id 已存在：' + id });
  if (projects.some((p) => p.prefix === prefix)) return sendJson(res, 400, { error: 'prefix 已被其他專案使用：' + prefix });
  const project = { id, name, prefix };
  projects.push(project);
  writeProjects(projects);
  fs.mkdirSync(path.join(CARDS_DIR, id), { recursive: true });
  sendJson(res, 201, project);
}

function handleProjectCardList(res, project) {
  sendJson(res, 200, readProjectCards(project));
}

function createCardRecord(project, input) {
  if (!isPlainObject(input)) throw new ApiError(400, 'body 必須是 object');
  const existing = readProjectCards(project);
  const maxNum = existing.reduce(
    (m, c) => Math.max(m, parseInt(c.id.slice(project.prefix.length + 1), 10) || 0),
    0
  );
  const stage = STAGES.includes(input.stage) ? input.stage : 'backlog';
  const inColumn = existing.filter((c) => c.stage === stage);
  const card = fillDefaults({
    id: project.prefix + '-' + String(maxNum + 1).padStart(3, '0'),
    project: project.id,
    title: typeof input.title === 'string' ? input.title.trim() : '',
    content: typeof input.content === 'string' ? input.content : '',
    stage,
    risk: RISKS.includes(input.risk) ? input.risk : 'low',
    owner: typeof input.owner === 'string' ? input.owner : DEFAULT_OWNER,
    agent: typeof input.agent === 'string' ? input.agent : '',
    approvalRequired: !!input.approvalRequired,
    createdAt: todayStr(),
    epic: typeof input.epic === 'string' ? input.epic : '',
    userStory: typeof input.userStory === 'string' ? input.userStory : '',
    track: TRACKS.includes(input.track) ? input.track : 'n/a',
    dependsOn: Array.isArray(input.dependsOn) ? input.dependsOn : [],
    order: inColumn.length + 1,
    readiness: input.readiness,
    gates: input.gates,
    links: input.links,
    refs: Array.isArray(input.refs) ? input.refs : [],
    evidence: input.evidence,
    comments: []
  });
  const err = validateCard(card, project.prefix);
  if (err) throw new ApiError(400, err);
  const cardMap = new Map(existing.map((x) => [x.id, x]));
  cardMap.set(card.id, card);
  const depErr = checkDependsOn(card, cardMap);
  if (depErr) throw new ApiError(400, depErr);
  writeCard(card, project.id);
  return card;
}

function handleCreateCard(res, project, body) {
  const input = parseBody(body);
  if (!isPlainObject(input)) return sendJson(res, 400, { error: 'body 必須是 object' });
  const card = createCardRecord(project, input);
  sendJson(res, 201, card);
}

function handlePutOne(res, project, id, body) {
  const c = fillDefaults(parseBody(body));
  if (!isPlainObject(c)) return sendJson(res, 400, { error: 'body 必須是完整 card object' });
  if (c.id !== id) return sendJson(res, 400, { error: 'body 的 id 與 URL 不一致' });
  c.project = project.id; // URL 為權威來源
  const err = validateCard(c, project.prefix);
  if (err) return sendJson(res, 400, { error: err });
  const cardMap = new Map(readProjectCards(project).map((x) => [x.id, x]));
  cardMap.set(c.id, c);
  const depErr = checkDependsOn(c, cardMap);
  if (depErr) return sendJson(res, 400, { error: depErr });
  writeCard(c, project.id);
  sendJson(res, 200, c);
}

function handlePutBulk(res, project, body) {
  const list = parseBody(body);
  if (!Array.isArray(list)) return sendJson(res, 400, { error: 'body 必須是 card 陣列' });
  for (const c of list) {
    if (isPlainObject(c)) c.project = project.id;
    const err = validateCard(fillDefaults(c), project.prefix);
    if (err) return sendJson(res, 400, { error: (c && c.id ? c.id + ': ' : '') + err });
  }
  const cardMap = new Map(readProjectCards(project).map((x) => [x.id, x]));
  for (const c of list) cardMap.set(c.id, c);
  for (const c of list) {
    const depErr = checkDependsOn(c, cardMap);
    if (depErr) return sendJson(res, 400, { error: depErr });
  }
  for (const c of list) writeCard(c, project.id);
  sendJson(res, 200, { updated: list.length });
}

function handleClaimCard(res, project, id, body) {
  const input = parseBody(body);
  if (!isPlainObject(input) || typeof input.agent !== 'string' || !input.agent.trim()) {
    throw new ApiError(400, 'agent 必須是非空字串');
  }
  const agent = input.agent.trim();
  if (agent.length > 100) throw new ApiError(400, 'agent 最多 100 字元');
  const card = readProjectCards(project).find((item) => item.id === id);
  if (!card) throw new ApiError(404, id + ' 不存在');
  if (card.agent && card.agent !== agent) {
    throw new ApiError(409, id + ' 已被其他 agent 認領', { claimedBy: card.agent });
  }
  card.agent = agent;
  writeCard(card, project.id);
  sendJson(res, 200, card);
}

function handleDelete(res, project, id) {
  const file = path.join(CARDS_DIR, project.id, id + '.json');
  if (!fs.existsSync(file)) return sendJson(res, 404, { error: id + ' 不存在' });
  fs.unlinkSync(file);
  sendJson(res, 200, { deleted: id });
}

/* ── server ── */

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', 'http://localhost');
  const pathname = requestUrl.pathname;
  try {
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(INDEX_HTML));
      return;
    }

    if (['GET', 'HEAD'].includes(req.method) && pathname.startsWith('/kanban-assets/app/')) {
      return sendStaticFile(
        req,
        res,
        PUBLIC_DIR,
        pathname.slice('/kanban-assets/app/'.length),
        'no-cache',
      );
    }

    if (['GET', 'HEAD'].includes(req.method) && pathname.startsWith('/kanban-assets/excalidraw/')) {
      return sendStaticFile(
        req,
        res,
        EXCALIDRAW_ASSETS_DIR,
        pathname.slice('/kanban-assets/excalidraw/'.length),
      );
    }

    if (pathname === '/api/config') {
      if (req.method === 'GET') return sendJson(res, 200, { owner: DEFAULT_OWNER, authRequired: !!AUTH_TOKEN });
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    if (pathname === '/api/epics') {
      if (req.method === 'GET') return sendJson(res, 410, { error: '請改用 /api/projects/:pid/epics' });
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    if (pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !hasValidBearerToken(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return sendJson(res, 401, { error: '需要有效的 bearer token' });
    }

    // 跨專案聚合視圖（唯讀）：每張卡帶 project 欄位
    if (pathname === '/api/cards') {
      if (req.method === 'GET') return sendJson(res, 200, readAllCards());
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // 專案清單
    if (pathname === '/api/projects') {
      if (req.method === 'GET') return sendJson(res, 200, readProjects());
      if (req.method === 'POST') return handleCreateProject(res, await readBody(req));
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    const blueprintDiscussionMatch = pathname.match(
      /^\/api\/projects\/([^/]+)\/blueprints\/([^/]+)\/discussions$/
    );
    if (blueprintDiscussionMatch) {
      const pid = decodeURIComponent(blueprintDiscussionMatch[1]);
      const blueprintId = decodeURIComponent(blueprintDiscussionMatch[2]);
      const project = getProject(pid);
      if (!project) throw new ApiError(404, '專案不存在：' + pid);
      if (!BLUEPRINT_ID_RE.test(blueprintId)) throw new ApiError(400, 'blueprint id 格式不合法');
      if (!readBlueprint(project, blueprintId)) throw new ApiError(404, 'blueprint 不存在：' + blueprintId);
      if (req.method === 'GET') return sendJson(res, 200, readBlueprintDiscussions(project, blueprintId));
      if (req.method === 'POST') {
        return handleCreateBlueprintDiscussion(res, project, blueprintId, await readBody(req));
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    const blueprintProposalResolutionMatch = pathname.match(
      /^\/api\/projects\/([^/]+)\/blueprints\/([^/]+)\/proposals\/([^/]+)\/(accept|reject)$/
    );
    if (blueprintProposalResolutionMatch) {
      const pid = decodeURIComponent(blueprintProposalResolutionMatch[1]);
      const blueprintId = decodeURIComponent(blueprintProposalResolutionMatch[2]);
      const proposalId = decodeURIComponent(blueprintProposalResolutionMatch[3]);
      const action = blueprintProposalResolutionMatch[4];
      const project = getProject(pid);
      if (!project) throw new ApiError(404, '專案不存在：' + pid);
      if (!BLUEPRINT_ID_RE.test(blueprintId)) throw new ApiError(400, 'blueprint id 格式不合法');
      if (!ENTITY_ID_RE.test(proposalId)) throw new ApiError(400, 'proposal id 格式不合法');
      if (req.method === 'POST') {
        return handleResolveBlueprintProposal(
          res,
          project,
          blueprintId,
          proposalId,
          action === 'accept' ? 'accepted' : 'rejected',
          await readBody(req),
        );
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    const blueprintProposalMatch = pathname.match(
      /^\/api\/projects\/([^/]+)\/blueprints\/([^/]+)\/proposals$/
    );
    if (blueprintProposalMatch) {
      const pid = decodeURIComponent(blueprintProposalMatch[1]);
      const blueprintId = decodeURIComponent(blueprintProposalMatch[2]);
      const project = getProject(pid);
      if (!project) throw new ApiError(404, '專案不存在：' + pid);
      if (!BLUEPRINT_ID_RE.test(blueprintId)) throw new ApiError(400, 'blueprint id 格式不合法');
      if (!readBlueprint(project, blueprintId)) throw new ApiError(404, 'blueprint 不存在：' + blueprintId);
      if (req.method === 'GET') return sendJson(res, 200, readBlueprintProposals(project, blueprintId));
      if (req.method === 'POST') {
        return handleCreateBlueprintProposal(res, project, blueprintId, await readBody(req));
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    const blueprintMaterializeMatch = pathname.match(
      /^\/api\/projects\/([^/]+)\/blueprints\/([^/]+)\/materialize$/
    );
    if (blueprintMaterializeMatch) {
      const pid = decodeURIComponent(blueprintMaterializeMatch[1]);
      const blueprintId = decodeURIComponent(blueprintMaterializeMatch[2]);
      const project = getProject(pid);
      if (!project) throw new ApiError(404, '專案不存在：' + pid);
      if (!BLUEPRINT_ID_RE.test(blueprintId)) throw new ApiError(400, 'blueprint id 格式不合法');
      if (req.method === 'POST') {
        return handleMaterializeBlueprintTasks(res, project, blueprintId, await readBody(req));
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    const bm = pathname.match(/^\/api\/projects\/([^/]+)\/blueprints(?:\/([^/]+))?(?:\/(operations|events))?$/);
    if (bm) {
      const pid = decodeURIComponent(bm[1]);
      const project = getProject(pid);
      if (!project) throw new ApiError(404, '專案不存在：' + pid);
      const blueprintId = bm[2] ? decodeURIComponent(bm[2]) : null;
      const action = bm[3] || null;

      if (!blueprintId) {
        if (req.method === 'GET') return sendJson(res, 200, listBlueprints(project));
        if (req.method === 'POST') return handleCreateBlueprint(res, project, await readBody(req));
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      if (!BLUEPRINT_ID_RE.test(blueprintId)) throw new ApiError(400, 'blueprint id 格式不合法');

      if (action === 'operations') {
        if (req.method === 'POST') {
          return handleBlueprintOperations(res, project, blueprintId, await readBody(req));
        }
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      if (action === 'events') {
        if (req.method === 'GET') {
          return handleBlueprintEvents(req, res, project, blueprintId, requestUrl.searchParams);
        }
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      if (req.method === 'GET') {
        const document = readBlueprint(project, blueprintId);
        if (!document) throw new ApiError(404, 'blueprint 不存在：' + blueprintId);
        return sendJson(res, 200, document);
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    const em = pathname.match(/^\/api\/projects\/([^/]+)\/epics$/);
    if (em) {
      const pid = decodeURIComponent(em[1]);
      const project = getProject(pid);
      if (!project) return sendJson(res, 404, { error: '專案不存在：' + pid });
      if (req.method === 'GET') return handleEpics(res, project);
      if (req.method === 'PUT') return handlePutEpics(res, project, await readBody(req));
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    const claimMatch = pathname.match(/^\/api\/projects\/([^/]+)\/cards\/([^/]+)\/claim$/);
    if (claimMatch) {
      const pid = decodeURIComponent(claimMatch[1]);
      const cardId = decodeURIComponent(claimMatch[2]);
      const project = getProject(pid);
      if (!project) throw new ApiError(404, '專案不存在：' + pid);
      if (!cardIdRe(project.prefix).test(cardId)) {
        throw new ApiError(400, 'id 必須符合 ^' + project.prefix + '-\\d{3,}$');
      }
      if (req.method === 'POST') return handleClaimCard(res, project, cardId, await readBody(req));
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // 專案卡片：/api/projects/:pid/cards[/:id]
    const pm = pathname.match(/^\/api\/projects\/([^/]+)\/cards(?:\/([^/]+))?$/);
    if (pm) {
      const pid = decodeURIComponent(pm[1]);
      const project = getProject(pid);
      if (!project) return sendJson(res, 404, { error: '專案不存在：' + pid });
      const cardId = pm[2] ? decodeURIComponent(pm[2]) : null;

      if (!cardId) {
        if (req.method === 'GET') return handleProjectCardList(res, project);
        if (req.method === 'PUT') return handlePutBulk(res, project, await readBody(req));
        if (req.method === 'POST') return handleCreateCard(res, project, await readBody(req));
        return sendJson(res, 405, { error: 'method not allowed' });
      }

      if (!cardIdRe(project.prefix).test(cardId)) {
        return sendJson(res, 400, { error: 'id 必須符合 ^' + project.prefix + '-\\d{3,}$' });
      }
      if (req.method === 'PUT') return handlePutOne(res, project, cardId, await readBody(req));
      if (req.method === 'DELETE') return handleDelete(res, project, cardId);
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof ApiError) {
      sendJson(res, err.status, { error: err.message, ...err.extra });
    } else if (err instanceof InvalidBodyError) {
      sendJson(res, 400, { error: 'body 不是合法 JSON：' + err.message });
    } else if (err instanceof PayloadTooLargeError) {
      sendJson(res, 413, { error: `request body 超過 ${MAX_BODY_BYTES} bytes` });
    } else {
      sendJson(res, 500, { error: 'request 失敗：' + err.message });
    }
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[kanban] port ${PORT} 已被占用。請先關掉占用的程序（lsof -i :${PORT}）再重新啟動。`);
  } else {
    console.error('[kanban] server 啟動失敗：' + err.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : PORT;
  console.log(`[kanban] 治理看板 → http://${HOST}:${actualPort}`);
  console.log(`[kanban] 資料目錄：${DATA_DIR}`);
});
