# Zeabur K3s deployment

這個 deployment 先提供兩條 private access path：

- Hermes pods：`http://monstrare.monstrare-system.svc.cluster.local:4420`
- 本地 WSL / Windows：透過 SSH tunnel 使用 `http://127.0.0.1:4420`

尚未綁定 Zeabur HTTPS domain 前，不把 bearer token 送到 public HTTP。

## 1. Create secrets

Secrets 不進 Git。產生一個 admin token，以及每個 agent 各自的 token，建立：

```bash
kubectl create namespace monstrare-system --dry-run=client -o yaml | kubectl apply -f -
kubectl -n monstrare-system create secret generic monstrare-secrets \
  --from-literal=KANBAN_AUTH_TOKEN='<admin token>' \
  --from-literal=KANBAN_IDENTITIES_JSON='[
    {"id":"wsl-codex","token":"<token>","roles":["worker","reviewer"]},
    {"id":"hermes1","token":"<token>","roles":["worker"]},
    {"id":"hermes2","token":"<token>","roles":["worker"]},
    {"id":"hermes3","token":"<token>","roles":["worker","reviewer"]}
  ]'
```

## 2. Deploy one writer

```bash
kubectl apply -f deploy/zeabur/monstrare.yaml
kubectl -n monstrare-system rollout status deployment/monstrare
kubectl -n monstrare-system get pod,service,pvc
```

Deployment 必須維持 `replicas: 1` 與 `strategy.type: Recreate`。目前 JSON store 不允許
rolling update 期間存在兩個 writer。

## 3. Local tunnel

從本地保持一個 SSH session：

```bash
ssh -L 4420:127.0.0.1:7442 zeabur \
  "sudo kubectl -n monstrare-system port-forward service/monstrare 7442:4420 --address 127.0.0.1"
```

另一個 shell：

```bash
export MONSTRARE_URL=http://127.0.0.1:4420
export MONSTRARE_TOKEN='<wsl-codex token>'
npm run agent -- identity
npm run agent -- next monstrare
```

Hermes pod 改用 cluster URL 和自己的 token。Agent client 可放在各 pod 的 `/opt/data`。

## 4. Reviewer gate

Worker submit：

```bash
npm run agent -- submit monstrare MON-001 \
  --claim '<claim id>' \
  --revision '<git sha>' \
  --summary 'implementation summary' \
  --checks-json '[{"command":"npm test","exitCode":0,"summary":"tests passed"}]'
```

不同 identity 的 reviewer 在自己的 checkout 重跑驗證後：

```bash
npm run agent -- review monstrare MON-001 \
  --submission '<submission id>' \
  --verdict approved \
  --summary 'independent review passed' \
  --checks-json '[{"command":"npm test","exitCode":0,"summary":"tests passed independently"}]'
```

Server 會拒絕 implementer 自審；只有 approved review 才會把 card 推進到 `done` 並通過
`test` 與 `code_review` gates。

## Remaining production gate

正式跨裝置使用前，需在 Zeabur 綁定 HTTPS domain，再把該 URL 發給外部裝置。ClusterIP
與 SSH tunnel 已足以驗證 WSL + 三個 Hermes pods 的 coordination flow，但不能取代公開
TLS ingress。
