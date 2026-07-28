# 畫面規格

## Metadata

- 功能：跨 agent Blueprint 討論、審核、任務拆分與認領
- 畫面：藍圖工作區
- 狀態：已實作

## 目的

讓使用者在同一個 project context 內觀看 agent streaming 建立的架構、選取節點討論、
接受或拒絕 agent patch，再把已確認的 `task` / `experiment` 轉成 Kanban cards。

## 版面配置

- 主要區域：藍圖選擇器、畫布／大綱 segmented control、Excalidraw semantic canvas。
- 次要區域：討論、待審提案、變更紀錄 inspector。
- 導覽：桌面固定左側 project nav；`<=760px` 改為首屏橫向 project rail。
- 動作：新增藍圖、選取／移動節點、留言、接受／拒絕提案、轉成任務卡。

## 狀態

| 狀態 | 必要行為 | 空狀態／錯誤文案 | 驗證方式 |
|---|---|---|---|
| 預設 | 顯示目前 project 的 document、revision 與 inspector | 不適用 | 桌面截圖 |
| 載入中 | 保留固定工作區尺寸，避免版面跳動 | `載入中…` | Browser |
| 空狀態 | 可建立第一張藍圖；未選 project 時停用寫入 | `尚未建立藍圖`／`請先選擇專案` | Contract test |
| 錯誤 | toast 顯示 API 錯誤，不覆蓋工作內容 | 使用 server 回傳訊息 | API / Browser |
| 停用 | 未選 task/experiment 時停用「轉成任務卡」 | 不額外顯示教學文字 | Browser |
| 權限不足 | 寫入 API 回 `401`，UI 顯示錯誤 toast | `缺少或無效的 bearer token` | API test |
| 行動裝置版 | project rail 可橫向切換；toolbar 44px；canvas 先聚焦單一節點；inspector 下移 | 與桌面共用文案 | 390x844 截圖 |

## 互動

| 動作 | 觸發條件 | 結果 | 失敗情境 |
|---|---|---|---|
| 移動節點 | 選取 semantic node 並拖曳 | 送出 `patchNode.layout` revision | revision stale 回 `409` 後 reload |
| 留言 | 有文字，可選或不選 node | 寫入 node-scoped 或 global discussion | 輸入空白不送出 |
| 預覽提案 | pending proposal | cyan dashed 投影 agent operations；不增加 revision、不寫回 layout | 無法解析時保留正式 document 並顯示錯誤 |
| 接受提案 | pending proposal | 原子套用 operations 並增加 revision | base revision stale 回 `409` |
| 轉成任務卡 | 選取未封存 task/experiment | 建卡並回寫 `linkedCardIds` | 已轉換節點不可重複轉換 |
| 認領卡片 | agent id 非空且卡片未被他人認領 | card `agent` 寫入認領者 | 衝突回 `409 claimedBy` |
| Agent lease | worker token 認領成功 | 顯示租約中與到期時間；heartbeat 延長 lease | 過期後其他 worker 可接手 |
| 提交審查 | claim owner 附 git revision 與成功 checks | 卡片進入驗證、顯示待獨立審查 | checks 缺少或失敗時拒絕 |
| Reviewer 核准 | reviewer 與 implementer 不同，且有獨立成功 checks | 卡片完成，test/code review gates 通過 | self-review 回 `409` |

## 設計系統對照

- 用到的既有 design token：paper/surface/raised/sunken、ink 三階、accent/good/warn/crit、
  4px spacing scale、4-8px radius、card/modal shadow。
- 用到的既有元件：Button、Input、Select、Project Nav、View Tabs、Toast、Ticket Card。
- 本畫面新做的元件：Blueprint Canvas 與 Blueprint Inspector；已登記於
  `ai/context/design-system.md`。

## 視覺驗收標準

- 1440px 桌面可同時看到 project nav、canvas 與 inspector。
- 390px 手機沒有橫向頁面 overflow；project rail、主要 tabs 與 Blueprint toolbar 不重疊。
- Canvas desktop 初始 framing 約 80% zoom；mobile 優先讓單一節點文字可讀，不強制塞入全圖。
- Agent proposal 預覽以 cyan dashed node / edge 區隔，離開預覽後正式 scene 不殘留草稿元素。
- Kanban lane 在桌面固定 282px，手機為 86vw，卡片標題與 metadata 保有間距。
- 介面使用自然、任務導向的繁體中文，不放模板式英文 eyebrow 或功能自述。
