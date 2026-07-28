# Distributed agent coordination v1

## Goal

讓本地 WSL agent 與 Zeabur 上的 `hermes1 / hermes2 / hermes3` 共用一個
project-scoped work queue，透過短期 lease 認領任務、提交可驗證證據，再由不同身份的
reviewer 審查。Monstrare server 是 coordination authority；Git repository 仍是程式碼與
diff 的 source of truth。

## Known deployment facts

- Zeabur VM 是單節點 K3s：2 vCPU、7.5 GiB RAM、約 43 GiB 可用磁碟。
- 三個 Hermes deployment 都有 Node 22、Git、Hermes CLI 與獨立 `/opt/data` persistent PVC。
- 看板必須維持單 replica；目前 atomic JSON store 不支援多個 server process 同時寫入。
- VM 的 `hermes1` shell alias 實際名稱是 `hermes`；`hermes2 / hermes3` aliases 正常。

## Identity and authorization

`KANBAN_AUTH_TOKEN` 是 browser / human admin token。Agent identities 由
`KANBAN_IDENTITIES_JSON` 注入：

```json
[
  {
    "id": "wsl-codex",
    "token": "<secret>",
    "roles": ["worker", "reviewer"]
  },
  {
    "id": "hermes1",
    "token": "<secret>",
    "roles": ["worker"]
  }
]
```

- token 決定 actor identity；agent 不得在 request body 冒用別的 `agent`。
- Agent token 只能呼叫 coordination endpoints，不能建立專案、覆寫卡片或刪除資料。
- Zeabur deployment 設 `KANBAN_REQUIRE_READ_AUTH=true`；除 health/config 外的 GET API 也需 token。
- `worker` 可 claim / heartbeat / release / submit。
- `reviewer` 可 review，但 server 強制 reviewer 與 submission implementer 不同。

## Storage

卡片 schema 保持相容。協作狀態另外存放：

```text
<DATA_DIR>/coordination/<projectId>/<cardId>.json
```

```json
{
  "version": 1,
  "state": "claimed",
  "claim": {
    "id": "uuid",
    "agentId": "hermes1",
    "claimedAt": "ISO timestamp",
    "heartbeatAt": "ISO timestamp",
    "expiresAt": "ISO timestamp"
  },
  "submission": null,
  "reviews": [],
  "events": []
}
```

Coordination file 與 card 一樣使用同目錄 temporary file + atomic rename。讀取 card API 時會
附加 `coordination` view，但一般 card `PUT` 不可覆寫 coordination authority。

## State machine

```text
available
  -> claimed
  -> review_pending
  -> approved
       or changes_requested -> claimed
```

- Claim lease 預設 15 分鐘，由 `KANBAN_CLAIM_TTL_SECONDS` 設定。
- heartbeat 必須帶目前 `claimId`；過期 claim 可由其他 worker 接手。
- submit 必須帶 immutable git revision、摘要，以及至少一個 exit code 0 的 check。
- approve 必須由不同 reviewer 提供自己的成功 checks；批准後才設 `stage=done`、
  `gates.test=true`、`gates.code_review=true`。
- v1 的 checks 是 authenticated reviewer attestation，不是 server 代跑任意 shell。
  後續可在相同 submission/review contract 後接 sandbox runner 與 signed provenance。

## API

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/identity` | authenticated | 查看 token 對應身份 |
| `POST` | `/api/projects/:pid/claims/next` | worker | 原子取得下一張 ready card |
| `POST` | `/api/projects/:pid/cards/:id/claim` | worker | 認領指定 card |
| `POST` | `/api/projects/:pid/cards/:id/heartbeat` | worker | 延長目前 lease |
| `POST` | `/api/projects/:pid/cards/:id/release` | worker | 主動釋放 |
| `POST` | `/api/projects/:pid/cards/:id/submit` | worker | 提交 revision 與驗證證據 |
| `POST` | `/api/projects/:pid/cards/:id/review` | reviewer | approve 或要求修改 |

## Deployment boundary

- Monstrare：一個 K3s Deployment、ClusterIP Service、persistent PVC。
- Agent pods 只需 HTTPS URL、identity token 與 client script，不共用 filesystem。
- 公開 endpoint 必須在 TLS 後面；禁止讓 bearer token 經過純 HTTP。
- Secrets 只放 Kubernetes Secret / Zeabur environment variables，不 commit 到 Git。
