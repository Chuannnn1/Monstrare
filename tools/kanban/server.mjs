/**
 * 治理看板 — 零依賴本地 / 可部署 server（跨專案版）
 *
 * 啟動：node tools/kanban/server.mjs（或 npm run kanban）
 * 環境變數：
 *   KANBAN_HOST      預設 127.0.0.1（部署到 Zeabur 設 0.0.0.0）
 *   KANBAN_PORT      預設 4420
 *   KANBAN_DATA_DIR  預設 server.mjs 所在目錄；放 projects.json 與 cards/
 * 資料：<DATA_DIR>/projects.json + <DATA_DIR>/cards/<projectId>/<PREFIX>-NNN.json
 *   （一卡一 JSON 檔，git tracked；每張卡帶 project 欄位）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);

const HOST = process.env.KANBAN_HOST || '127.0.0.1';
const PORT = Number(process.env.KANBAN_PORT) || 4420;
const DATA_DIR = process.env.KANBAN_DATA_DIR || ROOT;

const CARDS_DIR = path.join(DATA_DIR, 'cards');
const PROJECTS_JSON = path.join(DATA_DIR, 'projects.json');
const EPICS_JSON = path.join(DATA_DIR, 'epics.json');
const INDEX_HTML = path.join(ROOT, 'index.html'); // 靜態資產隨程式碼走，不在 DATA_DIR

fs.mkdirSync(CARDS_DIR, { recursive: true });

// 專案 id 與卡片 prefix 的格式
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const PREFIX_RE = /^[A-Z][A-Z0-9]*$/;
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

/* ── helpers ── */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
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

/** 固定 key 順序寫檔到 cards/<pid>/，2 空格縮排 + 結尾換行，減少 git diff 噪音 */
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
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, c.id + '.json'), JSON.stringify(normalized, null, 2) + '\n', 'utf8');
}

/* ── projects ── */

function readProjects() {
  try {
    const list = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeProjects(list) {
  fs.writeFileSync(PROJECTS_JSON, JSON.stringify(list, null, 2) + '\n', 'utf8');
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
  } catch {
    return [];
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

/* ── route handlers ── */

function handleEpics(res) {
  try {
    const epics = JSON.parse(fs.readFileSync(EPICS_JSON, 'utf8'));
    sendJson(res, 200, epics);
  } catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 200, { epics: [] });
    sendJson(res, 500, { error: '讀取 epics.json 失敗：' + err.message });
  }
}

function handleCreateProject(res, body) {
  const input = JSON.parse(body);
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

function handleCreateCard(res, project, body) {
  const input = JSON.parse(body);
  if (!isPlainObject(input)) return sendJson(res, 400, { error: 'body 必須是 object' });
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
  if (err) return sendJson(res, 400, { error: err });
  const cardMap = new Map(existing.map((x) => [x.id, x]));
  cardMap.set(card.id, card);
  const depErr = checkDependsOn(card, cardMap);
  if (depErr) return sendJson(res, 400, { error: depErr });
  writeCard(card, project.id);
  sendJson(res, 201, card);
}

function handlePutOne(res, project, id, body) {
  const c = fillDefaults(JSON.parse(body));
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
  const list = JSON.parse(body);
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

function handleDelete(res, project, id) {
  const file = path.join(CARDS_DIR, project.id, id + '.json');
  if (!fs.existsSync(file)) return sendJson(res, 404, { error: id + ' 不存在' });
  fs.unlinkSync(file);
  sendJson(res, 200, { deleted: id });
}

/* ── server ── */

const server = http.createServer(async (req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  try {
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(INDEX_HTML));
      return;
    }

    if (pathname === '/api/config') {
      if (req.method === 'GET') return sendJson(res, 200, { owner: DEFAULT_OWNER });
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    if (pathname === '/api/epics') {
      if (req.method === 'GET') return handleEpics(res);
      return sendJson(res, 405, { error: 'method not allowed' });
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
    if (err instanceof SyntaxError) {
      sendJson(res, 400, { error: 'body 不是合法 JSON：' + err.message });
    } else {
      sendJson(res, 500, { error: '寫入失敗：' + err.message });
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
  console.log(`[kanban] 治理看板 → http://${HOST}:${PORT}`);
  console.log(`[kanban] 資料目錄：${DATA_DIR}`);
});
