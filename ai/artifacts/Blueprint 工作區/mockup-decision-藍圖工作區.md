# Mockup 決策

## Metadata

- 功能：跨專案 Kanban 與 agent-assisted Blueprint
- 畫面：藍圖工作區
- 決策負責人：Chuannnn
- 狀態：已選定

## 變體

| 變體 | 說明 | 優點 | 風險 |
|---|---|---|---|
| A | 頂部 project selector + 緊湊 Kanban | 實作簡單、工作區較寬 | 跨專案切換不直覺，卡片過擠 |
| B | 固定左側 project nav + canvas / inspector workbench | 一鍵切換、context 持續可見、討論與審核並列 | 手機需重排導覽與 inspector |
| C | 全螢幕 canvas + 浮動 overlay panels | 畫布最大 | panel 會遮內容，mobile 與鍵盤操作風險高 |

## 設計系統對照

- 重用的 token／元件：Dark Operations tokens、Button、Select、Project Nav、View Tabs、
  Ticket Card、Toast。
- 新做並登記回 inventory 的元件：Blueprint Canvas、Blueprint Inspector。

## 選定的變體

- 變體：B
- 為何選這個：使用者明確要求左側可快速跳選 project，並指出原 Kanban 過密與切換不順。
  固定 nav 讓 project context 始終可見，inspector 也能承接人與 agent 的討論／審核。
- 實作前要求的修改：改為高科技感暗色；增加 lane 與卡片留白；移除模板感英文與急就章文案；
  mobile 將 nav 轉橫向 rail、inspector 移到 canvas 下方。

## 人工核准

- 核准者：Chuannnn
- 日期：2026-07-26
- 備註：核准依據為對話中的明確 UX 指示；實作後需由 browser screenshot 再驗收。
