# 跨專案看板設計（cross-project）v2

## 動機

原版看板是「單一專案」：`server.mjs` 寫死 `CARDS_DIR = ROOT/cards`、`ID_PREFIX = 'TASK'`，
所有卡片攤平在同一個 `cards/` 目錄，`epics.json` 也只有一組。實務上一個人會同時跑多個專案
（例如 golem / openclaw / nekosub），需要在同一個看板實例裡切換、各專案卡片互不干擾，
左側再放一個 project panel 做切換與新增。

同時，這個設計要能配合三裝置（2 PC + Zeabur VM）的部署：server 必須可透過環境變數設定
`host / port / 資料目錄`，才能從「只 bind 127.0.0.1、資料寫死在 repo 內」變成「可部署到
Zeabur、資料放 persistent volume」。

## 資料模型

- 專案清單：`<DATA_DIR>/projects.json`
  - 陣列，每項 `{ id, name, prefix }`
  - `id`：slug，`^[a-z0-9][a-z0-9-]*$`（作為目錄名與 API 路徑段）
  - `prefix`：卡片 id 前綴，`^[A-Z][A-Z0-9]*$`（例：`GOLEM`、`NEKO`）
  - 檔案不存在時視為空陣列 `[]`
- 卡片：`<DATA_DIR>/cards/<projectId>/<PREFIX>-NNN.json`
  - 每張卡新增 `project` 欄位（= projectId），供跨專案聚合視圖使用
  - 流水號**每個專案獨立**：golem 有 `GOLEM-001`、nekosub 有 `NEKO-001`，互不影響
- Epics：`<DATA_DIR>/epics/<projectId>.json`
  - 格式 `{ "epics": [] }`；不存在時回空陣列
  - 不再共用全域 `epics.json`

### Persistence contract

- Zeabur 的 `KANBAN_DATA_DIR` 必須指向 persistent volume；container image filesystem 不可作為資料層。
- `projects.json`、cards、epics 全部採「同目錄 temp file + atomic rename」寫入，避免 process restart 留下半份 JSON。
- 只有 `ENOENT` 視為空資料；JSON 損壞或權限錯誤回 500，禁止把損壞資料當空清單覆寫。
- v2 file store 僅支援**單一 server replica**。多 replica / 高併發若成為需求，應升級 SQLite/PostgreSQL，不能靠共享 JSON 猜測一致性。

## 環境變數（同時服務「可測試」與「可部署」）

| 變數 | 預設 | 用途 |
| --- | --- | --- |
| `KANBAN_HOST` | `127.0.0.1` | 部署到 Zeabur 時設 `0.0.0.0` |
| `KANBAN_PORT` | `4420` | 部署 / 測試用隨機埠 |
| `KANBAN_DATA_DIR` | server.mjs 所在目錄 | 放 `projects.json` 與 `cards/`；Zeabur 指向 volume |
| `KANBAN_AUTH_TOKEN` | 空 | Bearer token；非 loopback bind 時必填 |
| `KANBAN_IDENTITIES_JSON` | `[]` | Agent identity / token / roles |
| `KANBAN_CLAIM_TTL_SECONDS` | `900` | Agent claim lease 秒數 |
| `KANBAN_REQUIRE_READ_AUTH` | `false` | 對外部署設 `true`，保護 GET API |
| `KANBAN_MAX_BODY_BYTES` | `1048576` | request body 上限，超過回 413 |

非 `127.0.0.1` / `localhost` / `::1` 的 bind 若未設定 admin token 或 agent identities，
server 直接拒絕啟動。所有寫入 API 都要求 bearer token；agent token 只可呼叫 coordination
endpoints。`KANBAN_REQUIRE_READ_AUTH=true` 時，health/config 以外的 GET 也需 token。

## API 契約

| Method | Path | 說明 |
| --- | --- | --- |
| `GET` | `/api/projects` | 專案清單（陣列） |
| `POST` | `/api/projects` | 新增專案 `{id,name,prefix}`；建立 `cards/<id>/`；id 重複回 400 |
| `GET` | `/api/projects/:pid/cards` | 該專案全部卡片 |
| `POST` | `/api/projects/:pid/cards` | 新增卡，id = `<PREFIX>-NNN`，`project` = pid，回 201 |
| `PUT` | `/api/projects/:pid/cards` | 批次覆寫該專案指定卡片 |
| `PUT` | `/api/projects/:pid/cards/:id` | 覆寫單卡 |
| `DELETE` | `/api/projects/:pid/cards/:id` | 刪卡 |
| `GET` | `/api/projects/:pid/epics` | 讀取該專案 epics |
| `PUT` | `/api/projects/:pid/epics` | 寫入 `{epics: []}` |
| `GET` | `/api/cards` | 跨專案聚合，每張卡都帶 `project` 欄位（左側 panel 的「全部」視圖用） |

舊 `GET /api/epics` 回 410，前端必須切到 project-scoped endpoint。

### 驗證規則（沿用並擴充原版）

- `pid` 必須是已存在的專案，否則 404。
- 卡片 `id` 必須符合該專案 prefix 的格式 `^<PREFIX>-\d{3,}$`。
- `dependsOn` 硬防呆（格式 / 自我依賴 / 存在性 / 循環 / 推進阻擋）沿用原版，
  但存在性與循環偵測**限縮在同一專案內**（跨專案依賴 v1 不支援）。

## 前端 integration

- desktop 固定左側 project navigation，列出 `/api/projects` +「全部專案」；點一下直接切換，active project 同步顯示在 workspace header。mobile 改為橫向可捲動 project rail。
- sidebar `＋` 展開 compact project form，透過 `POST /api/projects` 建立專案。
- 所有 card 寫入依卡片的 `project` 改送 `/api/projects/:pid/cards`；全部視圖的 bulk update 先按 project 分組。
- `/api/config.authRequired` 為 true 時顯示 bearer token input；token 只保存在 browser `sessionStorage`，並附加到 API request。
- 視覺採 neutral charcoal dark theme；cyan 作為互動 accent，green / amber / red 分別表達完成、驗證與阻擋狀態，不使用漸層或單一藍紫色盤。
- 原本名為「藍圖」的 Epic 視圖改名為 `Roadmap`，把 `Blueprint` 名稱保留給後續 agent-assisted strategy canvas。

## Migration 與向後相容

不保留舊的攤平式 `/api/cards` 寫入路徑。一次性工具預設只 dry-run：

```powershell
npm run kanban:migrate -- --map infra=monstrare
npm run kanban:migrate -- --map infra=monstrare --apply
```

- seed `golem / openclaw / nekosub / monstrare` 四個初始專案。
- 已知 `epic` 與 project id 相同時自動歸類；無法判定者必須用 `--map SOURCE=PROJECT`，不猜測。
- `TASK-NNN` 依專案 prefix 重映射，並同步改寫同專案 `dependsOn`。
- `--apply` 只建立新結構，**保留舊 flat source**；重跑內容相同則安全略過，內容衝突則停止。

## 驗證範圍

全部採 `node:test` 黑箱測試、零 runtime dependency。每個 case 使用 OS 配發的 ephemeral port 與獨立 temp data directory，涵蓋跨專案 CRUD、corrupt-data fail closed、atomic persistence、migration dry-run/apply/idempotency、bearer auth、body limit、external bind fail closed 與 project-scoped epics。Windows 與 WSL Linux 都是 release gate。
