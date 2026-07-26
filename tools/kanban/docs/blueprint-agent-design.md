# Agent-assisted Blueprint v1

## Goal

Blueprint 是 project-scoped 的策略白板，不是另一個自由聊天視窗。人與不同 LLM agent
先討論，再由 agent 以可回放的 typed operations 逐步建立人類可理解的結構；使用者可在
renderer 上調整、評論、接受或拒絕後續 patch，最後把 `task` / `experiment` nodes 轉成
Kanban cards 供 agent 認領。

v1 先鎖定 renderer-independent protocol。Excalidraw / tldraw 只負責顯示與人工 layout，
不作為語意資料的 source of truth。

## Storage

```text
<DATA_DIR>/blueprints/<projectId>/<blueprintId>/
  blueprint.json
  revisions/
    000001.json
    000002.json
```

`blueprint.json`：

```json
{
  "id": "startup-pitch",
  "project": "monstrare",
  "title": "Monstrare startup pitch",
  "template": "startup-pitch",
  "revision": 2,
  "createdAt": "2026-07-26T00:00:00.000Z",
  "updatedAt": "2026-07-26T00:05:00.000Z",
  "nodes": [],
  "edges": []
}
```

每個 revision file 保存 actor、message、operations 與套用後的 document snapshot。revision
先寫、current document 後寫；讀取時若 revision snapshot 較新，以 revision 為準，避免
process crash 讓已提交 event 消失。

## Semantic nodes

允許的 node type：

- `problem`
- `customer`
- `insight`
- `solution`
- `value`
- `distribution`
- `business-model`
- `moat`
- `risk`
- `experiment`
- `component`
- `decision`
- `task`
- `note`

Node 必填 `id / type / title`，並可帶：

- `body`
- `status`: `draft / fact / assumption / hypothesis / decision`
- `confidence`: `0..1`
- `refs`: evidence / file / URL references
- `linkedCardIds`
- `layout`: optional `{ x, y, w, h }`
- `createdBy / updatedBy`
- `archived`

Agent 不必產生 layout。沒有 layout 的 node 交給 renderer template 自動排版。

Edge 必填 `id / from / to / relation`，relation 允許：

- `supports`
- `contradicts`
- `depends-on`
- `leads-to`
- `validates`
- `contains`
- `related`

## Operation batch

```json
{
  "baseRevision": 1,
  "actor": {
    "type": "agent",
    "id": "codex",
    "model": "gpt"
  },
  "message": "Add the first problem and proposed solution",
  "operations": [
    { "type": "upsertNode", "node": {} },
    { "type": "patchNode", "nodeId": "problem-1", "changes": {} },
    { "type": "archiveNode", "nodeId": "obsolete-idea" },
    { "type": "upsertEdge", "edge": {} },
    { "type": "archiveEdge", "edgeId": "edge-1" }
  ]
}
```

- 一個 batch 只增加一次 revision。
- `baseRevision` 不等於 current revision 時回 `409`，agent 必須重新讀取後 rebase。
- v1 不 hard-delete nodes / edges，只能 archive。
- 每批最多 50 operations。

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects/:pid/blueprints` | Blueprint summaries |
| `POST` | `/api/projects/:pid/blueprints` | Create `{ id, title, template }` |
| `GET` | `/api/projects/:pid/blueprints/:bid` | Current semantic document |
| `POST` | `/api/projects/:pid/blueprints/:bid/operations` | Apply one revision batch |
| `GET` | `/api/projects/:pid/blueprints/:bid/events?after=N` | Replay then stream SSE revisions |

所有 POST 沿用 `KANBAN_AUTH_TOKEN`。SSE event name 為 `blueprint-revision`，`data` 是 revision
event（不含重複的 full snapshot），renderer 依 operations streaming 更新畫面。

## Next gates

1. Blueprint view 顯示 revision stream 與 semantic nodes。
2. 加入 renderer adapter，先以 Excalidraw 呈現。
3. Selected node / region discussion 與 proposed patch preview。
4. 將 `task` / `experiment` nodes materialize 成 Kanban cards。
5. Agent claim、execution evidence 與 Blueprint status 回寫。

