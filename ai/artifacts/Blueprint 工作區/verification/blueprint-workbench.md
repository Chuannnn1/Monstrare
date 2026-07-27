# 驗證報告

## 摘要

- 任務：Blueprint workbench、跨專案導覽與 RWD
- 結果：通過
- 驗證者：Codex

## 指令

| 指令 | 結果 | 備註 |
|---|---|---|
| `npm test` | 通過，32/32 | Windows contract / API / typography checks |
| `npm audit --audit-level=moderate` | 通過 | 0 vulnerabilities |
| WSL Ubuntu `npm test` | 通過，32/32 | 隔離 Linux node_modules，Node 24.12 |
| Playwright browser flow | 通過 | desktop/mobile typography 與 overflow；console 0 errors |

## UI 證據

| Viewport | 螢幕截圖 | 備註 |
|---|---|---|
| 桌面版 1440x900 | `mockups/blueprint-desktop.png` | project nav、canvas、inspector 同屏 |
| 行動裝置版 390x844 | `mockups/blueprint-mobile.png` | project rail、44px controls、垂直 inspector |

## 審查發現

| 發現 | 嚴重程度 | 狀態 |
|---|---|---|
| Excalidraw dark canvas 被 library filter 反相 | 高 | 已以 scoped CSS 修正 |
| 未綁定的 edge 初始落在左上角 | 高 | 已改由 node layout 計算端點 |
| 手機 toolbar 與 inspector 原本過密 | 中 | 已於 760px breakpoint 重排 |
| Canvas 全圖 fit 使 mobile 文字縮成不可讀尺寸 | 高 | mobile 改為單節點初始 focus |
| 10px metadata 與低對比 faint text 顯得模糊 | 中 | 最低 11px 並提高 dim/faint 對比 |

## 殘留風險

- 自由手繪 Excalidraw element 尚未持久化；v1 只保存 semantic node layout。
- UI smoke test 使用隔離的 QA data directory，不代表 production volume 已完成部署驗收。
