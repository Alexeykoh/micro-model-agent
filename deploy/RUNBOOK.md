# MMA — Runbook + SLO (deployment/ops, P1)

## SLO (targets)

| Signal                    | Target                                 | Source                                 |
| ------------------------- | -------------------------------------- | -------------------------------------- |
| Task success (evals gate) | ≥ 80% pass, safety = 0                 | `bun scripts/evals-check.ts` (CI gate) |
| Liveness                  | `/healthz` 200, 99.9% over 30d         | kubelet/docker HEALTHCHECK             |
| Readiness                 | `/readyz` 200 when provider reachable  | `handleReady` (30s cache)              |
| Turn latency p95          | provider-bound; alert if > 5 min/turn  | OTel `llm.chat` spans                  |
| Cost/case                 | `cost.maxRunUsd` hard-stop (whole USD) | `stopReason=cost_budget`               |
| Bypass                    | `executor.denied` = 0 in prod          | OTel `tool.call` metrics               |

## Rollback (one command)

```bash
# Kubernetes (previous revision, no rebuild):
kubectl rollout undo deployment/mma -n mma
# Docker Compose / plain Docker (previous image tag):
docker run --rm -p 8080:8080 -e MMA_SERVICE_TOKEN="$SECRET" mma-service:<prev-tag>
# History:
kubectl rollout history deployment/mma -n mma
```

## Incident playbooks

- **`/readyz` 503 `no-model`**: provider unreachable or preflight failed.
  Check provider keys (`service.token` is separate from provider keys),
  `GET /v1/ready` detail, then provider status page. Pod keeps serving
  `/healthz`; traffic should drain via readiness.
- **Kill-switch**: set `hitl.killSwitch: true` in config (or flip the
  `hitl` section) — current turns stop at the next iteration boundary;
  new sessions fail-fast. Re-enable after root cause.
- **Sandbox unavailable** (`execution.sandbox_unavailable`): Docker daemon
  down while `execution.profile=sandbox`. Fail-closed by design — either
  restore Docker or switch profile to `local-trusted` explicitly.
- **Disk full from sessions**: `mma session prune` / retention
  (`memory.retentionDays`, `pruneByRetention`); sessions archive is 30d,
  service events 7d by default.
- **Token rotation**: local daemon — `mma serve --rotate-token` regenerates
  `~/.mma/daemon.token` at start (clients read the same file; a running daemon
  keeps the old token until restart). Kubernetes — update the `MMA_SERVICE_TOKEN`
  secret and `kubectl rollout restart deployment/mma -n mma`; old tokens stop
  working on pod swap.
- **TLS**: in-app — set `service.tls.cert`/`service.tls.key` (PEM paths) and the
  daemon serves HTTPS. Ingress — TLS terminates upstream; set
  `MMA_SERVICE_TLS_PROXY=true` (or `service.tls.terminatedByProxy: true`) so the
  pod may bind non-loopback over HTTP. Non-loopback without either is refused at
  startup.

## Tenants / RBAC (silo model)

1 process = 1 tenant. Multi-tenant = N processes (K8s Deployments) behind
a single ingress, each with its own `MMA_SERVICE_TOKEN` secret and
`X-Mma-Tenant` header check (`tenantOk` in `server.ts`, 403 on mismatch).
Cluster RBAC: `deploy/k8s.yaml` ships a least-privilege `Role`
(secret read scoped to `mma-service` only). No cross-tenant access exists
in-process by construction.
