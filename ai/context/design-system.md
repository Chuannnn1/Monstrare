# 設計系統（Design System）

由 Epic 0「專案設置」的「UI 設計系統」User Story 分五階段（框架 → 風格 → design token → 元件庫 → 版面）逐步填寫。**這份文件是後續所有功能 Epic 做 UI 時的單一事實來源**：任何前端任務開工前都要先讀它，能用既有 token／元件就必須用；缺的元件要照既有風格補做並登記回這裡（見 `ai/skills/project-kickoff.md` 步驟 6 與 `ai/skills/ui-mockup-gate.md`）。

狀態：Monstrare Kanban / Blueprint v1 已落地，後續變更需維持相容。

## S1 底層框架

- UI 框架：主介面使用 vanilla HTML / CSS / JavaScript；Blueprint canvas 是 React 18 island。
- 元件庫策略：操作介面沿用專案內自建元件；空間畫布使用 Excalidraw 0.17.6。
- 樣式方案：`tools/kanban/index.html` 內的 CSS custom properties 與元件 class。
- 選定理由：保留單檔 Kanban 的低部署成本，只把需要成熟 geometry / interaction engine
  的畫布隔離為可獨立 build 的 island。
- 人工核准：Chuannnn／2026-07-26（依暗色科技感、左側快速切換與 RWD 的明確要求）

## S2 風格方向

- 選定的 style tile：Dark Operations
- 色彩情緒：接近黑色的中性底色，cyan 作主要互動提示，綠／黃／紅只表達狀態。
- 字體個性：Segoe UI Variable Text 搭配 Microsoft JhengHei UI 繁中 fallback；
  不合成缺少的字重，短標籤清楚、長內容可讀。
- 圓角／陰影傾向：4-8px 小圓角、細邊界；陰影只用在可互動卡片 hover 與 modal。
- 密度：舒適但可掃讀；Kanban lane 固定 282px，卡片內距 14-17px。
- 亮／暗模式：暗色模式。
- 參考產品：Linear 的操作密度、Excalidraw 的空間操作、IDE project switcher 的固定導覽。
- 人工核准：Chuannnn／2026-07-26

## S3 Design Token 清單

### Primitive Token

| 類別 | Token | 值 | 備註 |
|---|---|---|---|
| 色彩 | paper / surface / raised / sunken | `#090b0e` / `#11151a` / `#171c22` / `#0c1014` | 四層中性背景 |
| 色彩 | ink / ink-dim / ink-faint | `#e8edf3` / `#b5bec8` / `#7f8b99` | 三層文字；暗色底維持可讀對比 |
| 色彩 | accent / good / warn / crit | `#42c7d5` / `#45d29a` / `#e2aa43` / `#f06870` | 動作與語意狀態 |
| 字級 | type scale | `11, 12, 13, 14, 15, 16, 18, 21px` | DOM 不低於 11px；canvas node 21px |
| 字重／行高 | regular / semibold / bold | `400 / 600 / 700`; 內文 `1.5-1.6` | |
| 間距 | spacing scale | `4, 8, 12, 16, 20, 24, 32px` | 以 4px 為基準 |
| 圓角 | radius | `4, 6, 8px`; pill `999px` | panel 不做浮動大圓角 |
| 陰影 | card / modal | `--shadow-card`, `--shadow-card-hover`, `--shadow-modal` | 只表示 elevation |
| z-index | base / topbar / sidebar / overlay | `0 / 20 / 30 / 100` | |
| 動效 | fast | `150ms ease` | 尊重 `prefers-reduced-motion` |

### Semantic Token

| Token | 對應 primitive | 用途 |
|---|---|---|
| color.primary | accent | 主要動作、選取與 focus |
| color.surface | surface | 卡片與控制項背景 |
| color.danger | crit | 高風險與刪除動作 |
| color.text.secondary | ink-dim | 輔助資訊 |
| space.page | 12-16px | 主工作區 padding |

### 實際 token 檔位置

- 專案內真實 token 檔路徑：`tools/kanban/index.html` 的 `:root`。
- 人工核准：Chuannnn／2026-07-26

## S4 元件庫 Inventory

每做一個核心元件就登記一列。後續 Epic 缺元件、照風格補做後也要回來補登。

| 元件 | 狀態 | 涵蓋狀態 | 用到的 token | 檔案位置 | 截圖 | 來源階段 |
|---|---|---|---|---|---|---|
| Button | 已實作 | default/hover/focus/disabled/primary/danger | accent, line-strong, radius 6 | `tools/kanban/index.html` `.toolbar-btn` | Blueprint 證據圖 | S4 |
| Input | 已實作 | default/focus/disabled/error feedback | surface-sunken, line-strong | `tools/kanban/index.html` | Blueprint 證據圖 | S4 |
| Select | 已實作 | default/focus/disabled | surface, line-strong | `tools/kanban/index.html` | Blueprint 證據圖 | S4 |
| Ticket Card | 已實作 | default/hover/drag/risk/blocked | surface, semantic colors, card shadow | `tools/kanban/index.html` `.ticket-card` | Kanban | S4 |
| Project Nav | 已實作 | default/hover/active/mobile rail | accent-soft, line | `tools/kanban/index.html` `.project-nav-item` | Blueprint 證據圖 | Blueprint v1 |
| View Tabs | 已實作 | default/hover/active | surface-sunken, raised, accent | `tools/kanban/index.html` `.view-tabs` | Blueprint 證據圖 | Blueprint v1 |
| Modal/Dialog | 已實作 | closed/open/error/save/delete/claim | surface, modal shadow | `tools/kanban/index.html` `.modal` | Kanban | S4 |
| Toast/Alert | 已實作 | success/error | accent/crit | `tools/kanban/index.html` `.toast` | Runtime | S4 |
| Blueprint Canvas | 已實作 | loading/empty/document/selection/layout | surface-sunken, semantic colors | `tools/kanban/blueprint-canvas.jsx` | Blueprint 證據圖 | Blueprint v1 |
| Blueprint Inspector | 已實作 | empty/discussion/pending proposal/history | surface, line, ink tiers | `tools/kanban/index.html` `.blueprint-inspector` | Blueprint 證據圖 | Blueprint v1 |

（「來源階段」記錄這個元件是 S4 初建，還是後續某個功能 Epic 補做並回登的。）

## S5 各介面版面

| 介面／使用者端 | 選定版型 | Mockup 決策紀錄 | 人工核准 |
|---|---|---|---|
| Kanban 專案工作區 | 固定專案導覽 + 橫向 lanes | `ai/artifacts/Blueprint 工作區/mockup-decision-藍圖工作區.md` | Chuannnn／2026-07-26 |
| Blueprint 工作區 | Canvas + 右側 inspector；mobile 改垂直排列 | `ai/artifacts/Blueprint 工作區/mockup-decision-藍圖工作區.md` | Chuannnn／2026-07-26 |
