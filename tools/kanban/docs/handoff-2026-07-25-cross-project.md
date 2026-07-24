# Handoff

Branch: `feat/cross-project`
HEAD commit: `72710cb`
Base commit: `a187710`（main）

Branch 上兩個 commit：`7caa4e1`（TDD red）、`72710cb`（server 轉綠）。皆已 push 到 `origin`（Chuannnn1/Monstrare）。工作區乾淨；`cards/TASK-001..005.json` 是本地未追蹤的 demo 卡，不在 checkout 內。

## Completed

- server 支援環境變數 `KANBAN_HOST` / `KANBAN_PORT` / `KANBAN_DATA_DIR`（同時服務「測試隔離」與「Zeabur 部署」）。
- 專案模型：`<DATA_DIR>/projects.json`，`GET/POST /api/projects`。
- 卡片改為每專案獨立目錄與流水號：`<DATA_DIR>/cards/<pid>/<PREFIX>-NNN.json`，每卡帶 `project` 欄位。
- 專案化卡片 CRUD：`GET/PUT/POST/DELETE /api/projects/:pid/cards[/:id]`。
- `GET /api/cards` 改為跨專案聚合（唯讀）。
- dependsOn 的存在性/循環/推進檢查限縮在同專案內。
- 保留原有 `validateCard` / `fillDefaults` / `detectCycle` / `checkDependsOn` 邏輯。

## Files changed

- `tools/kanban/server.mjs`：整支改寫為跨專案版（env config + projects + project-scoped routes）。
- `package.json`：新增 `test` script（`node --test "tools/kanban/test/*.test.mjs"`，零依賴）。
- `tools/kanban/docs/cross-project-design.md`：契約設計文件（新增）。
- `tools/kanban/test/helper.mjs`：以 env 起隔離 server 實例（bounded readiness timeout）。
- `tools/kanban/test/cross-project.test.mjs`：8 條契約測試。

## Contract

環境變數（皆選填）：
- `KANBAN_HOST` 預設 `127.0.0.1`
- `KANBAN_PORT` 預設 `4420`
- `KANBAN_DATA_DIR` 預設 server.mjs 所在目錄；放 `projects.json` 與 `cards/`。`index.html` 一律從程式碼目錄（ROOT）供應，不受 DATA_DIR 影響。

Endpoints：

| Method | Path | Body | 成功回應 |
| --- | --- | --- | --- |
| GET | `/` `/index.html` | — | 靜態 index.html |
| GET | `/api/config` | — | `{ owner }`（本機 git user.name） |
| GET | `/api/epics` | — | `epics.json` 內容；檔案不存在回 `{ epics: [] }`。**仍為全域，未 project-scoped** |
| GET | `/api/cards` | — | 跨專案聚合 `Card[]`，每張帶 `project`（唯讀，無寫入） |
| GET | `/api/projects` | — | `Project[]` |
| POST | `/api/projects` | `{id,name,prefix}` | `201 Project` |
| GET | `/api/projects/:pid/cards` | — | `Card[]`（該專案） |
| POST | `/api/projects/:pid/cards` | 部分 card 欄位 | `201 Card`（id=`<PREFIX>-NNN`） |
| PUT | `/api/projects/:pid/cards` | `Card[]` | `{ updated: n }`（bulk 覆寫 / 排序） |
| PUT | `/api/projects/:pid/cards/:id` | 完整 `Card` | `200 Card` |
| DELETE | `/api/projects/:pid/cards/:id` | — | `{ deleted: id }` |

Project schema：`{ id, name, prefix }`
- `id`：`^[a-z0-9][a-z0-9-]*$`（目錄名與路徑段）
- `prefix`：`^[A-Z][A-Z0-9]*$`（卡片 id 前綴）
- `name`：非空字串

Card schema（key 順序即寫檔順序）：`id, project, title, content, stage, risk, owner, agent, approvalRequired, createdAt, epic, userStory, track, dependsOn, order, readiness, gates, links, refs, evidence, comments`
- `id`：`^<PREFIX>-\d{3,}$`；`project`：非空字串（以 URL/目錄為權威來源）
- `stage`：`backlog|blocked|ready|implementing|verify|done`；`risk`：`low|medium|high`；`track`：`frontend|backend|integration|n/a`
- `readiness`：7 個 boolean（problem_clear, non_goals_clear, acceptance_testable, files_known, scope_defined, verification_contract, human_approval_recorded）
- `gates`：6 個 boolean（product, ui, architecture, security, test, code_review）
- `links`：6 個字串（featureSpec, screenSpec, mockupDecision, taskCard, verificationReport, pr）
- `evidence`：`{ commands: string[], findings: string[], residual: string }`
- `comments`：`{ name, time, text }[]`
- `dependsOn`：`string[]`，每元素需符合**同專案** `^<PREFIX>-\d{3,}$`；不可含自己；存在性/循環偵測限同專案；推進到 `ready/implementing/verify/done` 前，dependsOn 的卡片都必須 `done`。

Validation / error 行為：
- Project：id/prefix 格式不符或 name 空 → 400；id 重複 → 400；prefix 重複 → 400。
- 未知 `:pid` → 404；`:id` 格式不符該專案 prefix → 400。
- Card 驗證失敗 → 400（訊息說明欄位）；dependsOn 缺件/循環/前置未完成 → 400。
- body 非合法 JSON → 400；不支援的 method → 405；寫檔錯誤 → 500。
- 寫檔：2 空格縮排 + 結尾換行。

## Verification

- 指令：`npm test`（= `node --test "tools/kanban/test/*.test.mjs"`）
- 結果：`tests 8 / pass 8 / fail 0`
- 環境：Windows_NT (win32)，Node v24.12.0
- **尚未在 Linux 跑過**（backend owner 請補一次 Linux 綠燈再鎖 contract）。

## Known failures

1. 前端寫入操作壞掉（設計內、待前端任務）。
   - 重現：`npm run kanban` → 開 `http://127.0.0.1:4420` → 按「+ 新增卡片」或拖曳卡片。
   - error：前端仍打已移除的 `POST/PUT /api/cards`、`/api/cards/:id` → 405/404。
   - GET 顯示不受影響，但因無 project、板面為空。
2. 所有 endpoint 無認證。預設 bind `127.0.0.1` 安全；一旦 `KANBAN_HOST=0.0.0.0` 對外，任何人可讀寫。

## Decisions

- 每專案獨立目錄 + 獨立 prefix/流水號：隔離、id 有語意、減少 git merge 衝突。
- 移除攤平寫入端點（`/api/cards` POST/PUT、`/api/cards/:id`），只留 `GET /api/cards` 當聚合；理由見 `cross-project-design.md`。
- env config 一石二鳥：同一組 `KANBAN_HOST/PORT/DATA_DIR` 同時開啟測試隔離與 Zeabur volume/bind。
- dependsOn 限同專案（v1 不支援跨專案依賴）。
- `index.html` 隨程式碼走（ROOT），資料在 `DATA_DIR`，為部署做分離。

## Unresolved

- **Auth/authz**：完全沒有。對外暴露前必補。
- **Persistence**：`cards/` + `projects.json` 在 DATA_DIR；Zeabur 上必須是 volume（避開 data-lost-on-restart）。
- **Migration**：舊攤平 `cards/*.json`（含 5 張未追蹤 demo 卡）會被 per-project reader 忽略成孤兒；需 migration 進 `cards/<pid>/` 並補 `project`。
- **project-scoped epics**：`/api/epics` 仍全域，設計上應 project-scoped；會影響前端資料來源。
- **Concurrency**：假設單一寫入者，無檔案鎖；bulk PUT 與 POST 之間非原子。
- **Projects 只有 create**：無 rename/delete API。
- 假設：`projects.json` 可手改；port 被占用直接 exit(1) 不換 port。
- Contract 文件 owner：建議由 **backend（Codex）** 接手 `cross-project-design.md`，因後續 auth/migration/epics 會移動契約。

## Next task

- 建議第一個動作：從 `72710cb` checkout（或以它為 base 開 backend branch），先在 **Linux 跑 `npm test` 取得綠燈**，再依你的 5 個 blocking findings 開始 backend hardening。
- Allowed files：`tools/kanban/server.mjs`、`tools/kanban/test/**`、`tools/kanban/docs/cross-project-design.md`（contract owner）、`package.json`、`projects.json`、`scripts/**`、`.github/**`。
- Files not to touch：`tools/kanban/index.html`（前端，contract 鎖定後由 Claude 接）。
- 協調規則：backend contract 變動時，**先更新契約測試，再通知 frontend rebase**；勿與 frontend 同時改 `server.mjs`／`index.html`。
