# Distributed agent coordination verification

Verified on 2026-07-28 against commit
`8daa402821cdd4c194f0a50dcef82d3030c21716`.

## Result

Monstrare is running as the shared coordination authority on the Zeabur VM.
Local Windows/WSL and the three Hermes pods can authenticate as separate
identities, atomically claim different cards, submit evidence, and complete an
independent review.

The live acceptance flow was:

| Actor | Role | Result |
| --- | --- | --- |
| `wsl-codex` | worker, reviewer | Claimed `E2E-001`; independently reviewed `E2E-002` |
| `hermes1` | worker | Claimed and submitted `E2E-002` |
| `hermes2` | worker | Claimed `E2E-003` |
| `hermes3` | worker, reviewer | Claimed `E2E-004` |

All four `next` calls returned distinct cards with active lease IDs. Hermes 1
submitted immutable revision `8daa402821cdd4c194f0a50dcef82d3030c21716`
and a successful client identity check. WSL reran the full test suite and
approved that submission as a different identity. The resulting card has:

- `stage=done`
- `coordination.state=approved`
- `implementerId=hermes1`
- `reviewerId=wsl-codex`
- `gates.test=true`
- `gates.code_review=true`

The server contract test also verifies that the implementer cannot review its
own submission and receives HTTP 409.

## Deployment

- Host: Ubuntu 24.04 single-node K3s on 2 vCPU / 7.5 GiB RAM.
- Namespace: `monstrare-system`.
- Workload: one `monstrare` replica with `Recreate` strategy.
- Storage: bound 2 GiB persistent volume at `/data`.
- Service: ClusterIP on port 4420.
- Image:
  `ghcr.io/chuannnn1/monstrare:sha-8daa402821cdd4c194f0a50dcef82d3030c21716`
- Image digest:
  `sha256:6cb0103a62280d53b7936d5592b7ea9bac992ec4570ecff243cccd2ecfb12619`
- Observed runtime after credential rotation: Ready, zero restarts, about
  17 millicores CPU and 12 MiB memory.

Hermes agents use the cluster-local URL:

```text
http://monstrare.monstrare-system.svc.cluster.local:4420
```

Windows and WSL use an SSH tunnel:

```text
http://127.0.0.1:4420
```

Bearer tokens are not exposed over public plaintext HTTP. The admin credential
was rotated after browser acceptance testing; the previous token returned 401
and the replacement token returned 200. The local credential file has one
non-inherited ACL entry for the current Windows user.

## Verification

| Check | Result |
| --- | --- |
| Windows `npm test` | 44/44 passed |
| Isolated WSL Linux `npm test` | 44/44 passed |
| `npm audit --audit-level=moderate` | 0 vulnerabilities |
| Node syntax and `git diff --check` | passed |
| GitHub Actions container run `30333146229` | passed |
| GHCR public image pull and digest | verified |
| Windows health through SSH tunnel | `status=ok`, storage readable |
| WSL health through SSH tunnel | `status=ok`, storage readable |
| Four-agent distinct claim flow | verified live |
| Hermes submit to WSL independent review | verified live |
| Browser coordination detail | correct implementer, revision, and reviewer |
| Browser console before forced token expiry | 0 errors, 0 warnings |

Browser evidence:
[distributed-agent-review.png](../mockups/distributed-agent-review.png)

## Architecture boundary

This version deliberately keeps Monstrare as a coordination plane, not a remote
shell executor:

1. Git remains the source of truth for code and diffs.
2. Monstrare owns identity, lease, submission, review, and audit state.
3. A reviewer independently checks a revision, then submits an authenticated
   attestation.
4. Only an approved review advances the card to `done`.

This keeps the current deployment small and auditable. It also leaves a stable
contract for a later sandbox runner that can attach signed test provenance
without changing the claim and review state machine.

## Remaining production gates

- Add a managed HTTPS domain before allowing direct cross-device Internet
  access. ClusterIP plus SSH tunnel is the current secure access boundary.
- Move coordination and card transitions into SQLite or PostgreSQL before
  adding multiple Monstrare server replicas. The current two-file update is
  atomic per file, not transactional across both files.
- Replace authenticated check attestations with a sandbox runner and signed
  provenance when untrusted agents need to execute validation.
- Add card-state SSE or WebSocket updates so boards do not require refresh.
- Package the persistent Hermes client configuration as a managed skill or
  service loop instead of a one-time pod bootstrap.
- Add reviewer policies by risk level, such as one reviewer for normal work and
  human approval plus two reviewers for production or security-sensitive work.
