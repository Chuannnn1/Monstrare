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
  discussions.json
  proposals/
    <proposalId>.json
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
| `GET/POST` | `/api/projects/:pid/blueprints/:bid/discussions` | Read/add global or node-scoped discussion |
| `GET/POST` | `/api/projects/:pid/blueprints/:bid/proposals` | Read/create an agent patch proposal |
| `POST` | `/api/projects/:pid/blueprints/:bid/proposals/:id/accept` | Human accepts and commits a proposal |
| `POST` | `/api/projects/:pid/blueprints/:bid/proposals/:id/reject` | Human rejects a proposal without revision |
| `POST` | `/api/projects/:pid/blueprints/:bid/materialize` | Create cards from task/experiment nodes |
| `POST` | `/api/projects/:pid/cards/:id/claim` | Atomically claim an unowned card for one agent |

所有 POST 沿用 `KANBAN_AUTH_TOKEN`。SSE event name 為 `blueprint-revision`，`data` 是 revision
event（不含重複的 full snapshot），renderer 依 operations streaming 更新畫面。

## Agent drawing flow

Agent 不需要模擬滑鼠，也不直接產生 Excalidraw JSON。它讀取目前的 semantic document，
再用 typed operations 描述要新增或修改的節點與關係；前端會把 operations 即時投影成
人可閱讀的 Excalidraw scene。

需要人工審核時，agent 建立 proposal：

```http
POST /api/projects/monstrare/blueprints/agent-workflow/proposals
Authorization: Bearer <KANBAN_AUTH_TOKEN>
Content-Type: application/json

{
  "baseRevision": 9,
  "actor": {
    "type": "agent",
    "id": "codex",
    "model": "gpt"
  },
  "message": "補上 VM 單點故障與備援工作",
  "operations": [
    {
      "type": "upsertNode",
      "node": {
        "id": "risk-single-point",
        "type": "risk",
        "title": "VM 成為單點故障",
        "status": "hypothesis"
      }
    },
    {
      "type": "upsertEdge",
      "edge": {
        "id": "edge-risk-hosting",
        "from": "risk-single-point",
        "to": "hosting-plan",
        "relation": "contradicts"
      }
    }
  ]
}
```

使用者可先在 canvas 預覽 cyan dashed node / edge；預覽期間不會建立 revision，也不會把
拖曳 layout 寫回正式 document。按下接受後才原子套用 operations。若工作流允許 agent
直接提交，可改呼叫 `/operations`；提交後由 SSE 將 revision stream 給所有已連線 client。

## Implemented v1

- Excalidraw renderer adapter 將 semantic nodes / edges 投影成可縮放、可選取、可移動的畫布；
  layout 調整會轉成 `patchNode` operation，語意 document 仍是 source of truth。
- Outline 是無 canvas 環境的可讀 fallback。
- 討論可綁定目前選取的 node，也可記在整張藍圖。
- agent proposal 先 dry-run 驗證；可在 canvas 預覽 cyan dashed 變更，人工接受才建立
  revision，取消預覽或拒絕皆不改 document。
- `task` / `experiment` node 可 materialize 成 project-scoped cards，並回寫 `linkedCardIds`。
- 卡片 claim 採 first-writer-wins；已被其他 agent 認領時回 `409` 與 `claimedBy`。
- 桌面使用固定左側 project nav；窄螢幕改為橫向 project rail，canvas 與 inspector 垂直排列。

## Current limits

- Excalidraw 的自由手繪元素不是 semantic document 的一部分；v1 只持久化 node layout。
- proposal 已能在 canvas 預覽 node / edge 結果，但 inspector 尚未提供逐欄位文字 diff。
- claim 只建立 owner，不含 lease / heartbeat；agent crash 後仍需人工重新指派。
