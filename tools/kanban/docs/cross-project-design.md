# 跨專案看板設計（cross-project）v1

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

## 環境變數（同時服務「可測試」與「可部署」）

| 變數 | 預設 | 用途 |
| --- | --- | --- |
| `KANBAN_HOST` | `127.0.0.1` | 部署到 Zeabur 時設 `0.0.0.0` |
| `KANBAN_PORT` | `4420` | 部署 / 測試用隨機埠 |
| `KANBAN_DATA_DIR` | server.mjs 所在目錄 | 放 `projects.json` 與 `cards/`；Zeabur 指向 volume |

## API 契約

| Method | Path | 說明 |
| --- | --- | --- |
| `GET` | `/api/projects` | 專案清單（陣列） |
| `POST` | `/api/projects` | 新增專案 `{id,name,prefix}`；建立 `cards/<id>/`；id 重複回 400 |
| `GET` | `/api/projects/:pid/cards` | 該專案全部卡片 |
| `POST` | `/api/projects/:pid/cards` | 新增卡，id = `<PREFIX>-NNN`，`project` = pid，回 201 |
| `PUT` | `/api/projects/:pid/cards/:id` | 覆寫單卡 |
| `DELETE` | `/api/projects/:pid/cards/:id` | 刪卡 |
| `GET` | `/api/cards` | 跨專案聚合，每張卡都帶 `project` 欄位（左側 panel 的「全部」視圖用） |

### 驗證規則（沿用並擴充原版）

- `pid` 必須是已存在的專案，否則 404。
- 卡片 `id` 必須符合該專案 prefix 的格式 `^<PREFIX>-\d{3,}$`。
- `dependsOn` 硬防呆（格式 / 自我依賴 / 存在性 / 循環 / 推進阻擋）沿用原版，
  但存在性與循環偵測**限縮在同一專案內**（跨專案依賴 v1 不支援）。

## 前端（後續，不在本次 TDD 範圍）

- 左側 project panel：列出 `/api/projects` + 一個「全部」聚合項；點選切換看板資料來源。
- panel 底部「+ 新增專案」→ `POST /api/projects`。

## 向後相容

v1 不保留舊的攤平式 `/api/cards` 寫入路徑；既有單專案資料以一次性 migration
（把 `cards/*.json` 移進 `cards/default/` 並補 `project:"default"`）處理，另立任務卡。

## 測試範圍（本次：TDD red）

先寫失敗測試鎖定上述契約，全部針對 server 黑箱（`node:test` 內建、零依賴），
用 `KANBAN_PORT` + `KANBAN_DATA_DIR` 起隔離實例。實作後轉綠。
