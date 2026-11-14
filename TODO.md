# TODO — Micro Models Agent

> **Актуально на 2026-11-09** (сверено с кодом; `dev`).
>
> Здесь только **открытая** работа. Закрытые пункты с обоснованиями и ссылками на
> гейты сохранены снимками в [`docs/archive/`](./docs/archive/) — последний
> полный снимок [`todo-2026-11-04.md`](./docs/archive/todo-2026-11-04.md);
> архивы закрытых 1.1–1.14 (вкл. webui-UX 1.13 и harness 1.14, закрыты 2026-11-09)
> — в git-истории TODO.md и по спеке
> [`2026-11-06-webui-pause-resume`](./docs/specs/2026-11-06-webui-pause-resume-design.md) /
> [`2026-11-08-agent-harness`](./docs/specs/2026-11-08-agent-harness-design.md) /
> [`2026-11-09-nested-agents-md`](./docs/specs/2026-11-09-nested-agents-md-design.md).
> Долгосрочная история — `CHANGELOG.md` и [`docs/agents/feature-history.md`](./docs/agents/feature-history.md).
> Отложенные решения — [`docs/agents/debt.md`](./docs/agents/debt.md) (правило 9, pay-once).
>
> **Проверка 2026-11-09:** все пункты ниже сверены с кодом. Частично сделанное
> отмечено (`уже есть: … / осталось: …`), чтобы не делать дважды.

---

## 1. Открыто сейчас

> Ранее 1.1–1.4, 1.6 (Learning Phase B — удалена решением пользователя 2026-11-09),
> 1.7–1.11, 1.12 (mma web хвосты), 1.13 (mma web UX), 1.14 (harness) — закрыты и
> убраны в архив 2026-11-09. Нумерация `§1.5` сохранена, чтобы не ломать ссылки
> вида `TODO §1.12` в коде/спеках/тестах (старые ссылки ищите в архиве).

### 1.5 Мелкие хвосты исполненных планов

- [x] Режим компакции `llm` — **закрыто 2026-11-09** веткой `feat/compaction-llm`
      (спека [`2026-11-09-compaction-llm-design`](./docs/specs/2026-11-09-compaction-llm-design.md)):
      `contextBudget.compactionSummary: off|ledger|llm` (default `ledger`),
      helper `summarizeOldTurns` (`src/core/context/compaction-llm-summary.ts`, bounded
      256 tok, timeout 8000мс, кэш `compaction-summaries` по sha256, fail-open → ledger-only),
      инъекция `[LLM summary]` в блок компакции, async-проводка через `CompactionService`
      (пролог/финалайзер `await`). Гварды — `tests/compaction-llm-summary.test.ts` (6),
      `tests/arch/double-honesty.test.ts` (записи новых методов).
- [x] Живая приёмка леджера контекста — **закрыто 2026-11-09** прогоном
      `hard-multi-extreme` (`_testing/live/ctx-probe/`, opencode-go `deepseek-v4.1-flash`,
      `exit=0`, 368с, 14 компакций, сессия `ses_mw98i03e_wpgaphgvmfngbcso`):
      агент вернул `NEEDLE_A_111` (hard-a:1800), `NEEDLE_B_222` (hard-b:3300),
      `NEEDLE_C_333` (hard-c:900), heading `# Quarterly Infrastructure Report …`,
      decoy count 0 (заодно верно отделил `corpus/decoy.md` от настоящего
      `PIN_ALPHA_9F3` в big-needle:2500); `.mma/NOTES.md` содержит `path:line`
      находки, блок компакции несёт `[Notes:` ×14 (не сырой контент).

---

## 3. Дорожная карта до продакшена

> Полный gap-анализ: [`docs/archive/specs/2026/2026-09-28-production-readiness-design.md`](./docs/archive/specs/2026/2026-09-28-production-readiness-design.md).
> Пункты — отдельные ветки от `dev`; каждый требует зелёных `bun test` + `bun run quality`.
> `master` не коммитим/не пушим (ветка релиза).

### P0 — без этого в прод нельзя

- [x] **Изоляция исполнения.** **Закрыто 2026-11-09** двумя ветками
      (спека [`2026-11-09-execution-sandbox-design`](./docs/specs/2026-11-09-execution-sandbox-design.md)):
      `execution.profile: local-trusted|sandbox` (дефолт прежний) + `execution.image`
      (`oven/bun:1.3.14`); bash в sandbox → `docker run --read-only`
      `--network none --cap-drop ALL -u 1000:1000`, mount только baseDir→`/work`,
      без ключей провайдера; fail-closed при недоступном Docker
      (`execution.sandbox_unavailable`); файловые тулы — за существующим jail;
      `Dockerfile` в корне + cert-acceptance живьём
      (`tests/bash-docker-live.test.ts`: mount виден хосту, запись вне mount
      запрещена, egress запрещён).
- [x] **Durable state.** **Закрыто 2026-11-09** четырьмя ветками:
      (1) `thread_id` (`thr_<16 hex>` в `SessionMeta`, спека
      [`2026-11-09-thread-id-design`](./docs/specs/2026-11-09-thread-id-design.md));
      (2) чекпоинтер хода `checkpoint.json` — снимок/восстановление `LoopState`
      на границе батча, атомарный write, fail-open (спека
      [`2026-11-09-checkpoint-design`](./docs/specs/2026-11-09-checkpoint-design.md),
      `src/modules/session/checkpoint{,-io}.ts`);
      (3) retention-prune `pruneByRetention(retentionDays)` (кроме активной);
      (4) long-term TTL `memory.retentionDays` (0 = без срока;
      `filterExpiredEntries`/`pruneExpired`, at-rest шифрование не трогается).
      Плюс честные сплиты ради потолка 300 строк
      (`checkpoint-io.ts`, `manager-lifecycle.ts`). Гварды — `tests/session/*`.
- [x] **Observability (OTel).** **Закрыто 2026-11-09** двумя ветками + fix
      (speки [`2026-11-09-otel-design`](./docs/specs/2026-11-09-otel-design.md)):
      адаптер `gen_ai.*` (`src/modules/otel/adapter.ts`), OTLP-JSON-экспорт
      (`fetchOutbound`-политика, fail-silent), декораторы `llm.chat`/`tool.call`,
      workflow-спаны `agent.run`, метрики `tool.execute`/`llm.chats`/
      `executor.denied` (bypass), `gen_ai.faithfulness.judge` (pass/contradiction/
      degraded), drift контекстного окна vs конфигурации (context-probe);
      связка `threadId`+`sessionId` на каждом спане. W5/W6-сигналы остаются
      отдельным долгом `observability-w5-w6`.
- [x] **Evals в контуре + staged rollout.** **Закрыто 2026-11-09** тремя ветками:
      скоpковер + trajectory-чекер + eval-gate в CI (спека
      [`2026-11-09-evals-design`](./docs/specs/2026-11-09-evals-design.md),
      bundled-манифест, gate ≥80%/safety=0),
      human-gold фикстуры (`tests/evals/gold-v1.json` по живому прогону
      hard-multi-extreme), staged-бакет (`rollout.ts`:
      shadow→canary→percentage→full при живом применении
      `applyStagedRollout` в session-runner), ensemble-судья
      (`EnsembleJudge`: большинство голосов, fail-open degraded).

### P1 — управляемость

> ⚠️ **Ограничитель: монолит UI + runtime в одном процессе.**
> Сейчас `CLI/REPL/WebHost` и `Agent` общаются in-process через `Host`
> (`src/core/host.ts`). Пока UI (терминал/веб) живёт в том же процессе,
> что и исполнитель, недоступны: control plane с подписанной политикой,
> thin-режим, отзыв доступа, централизованный аудит и разные клиенты
> одного демона. **Разделение — блокер для дальнейшего развития**
> (см. идею [`2026-11-09-mma-enterprise-separate-version.md`](./docs/ideas/2026-11-09-mma-enterprise-separate-version.md)
> §3.5, волны -1…W7 в §13). Без сетевого контракта `Host`/`HostStateSnapshot`/
> `OutputEvent` нельзя строить Enterprise поверх монолита — любой
> «enterprise-флаг» в монолите локально пропатчится.

- [x] **Разделение монолита UI / runtime (волны -1…W7).**
      Спека: [`2026-11-10-monolith-split-design`](./docs/specs/2026-11-10-monolith-split-design.md).
      Статус на 2026-11-13; рабочая линия — `v0_26_0`.
      - [x] **Волна -1** — wire-протокол (`feat/daemon-wire`): `mma serve`, `/v1`+SSE,
            версия протокола, токен `~/.mma/daemon.token`, `DaemonClient`.
      - [x] **W0** — общий runtime-слой (`refactor/runtime-layer-split`):
            `src/runtime/**`, `service`/`core` больше не импортируют `modules/webui`.
      - [x] **W1** — контракт `Host` v2 (`feat/host-local`): async `getState`,
            `subscribeEvents`/`HostEvent`, `LocalHost`, REPL — потребитель `Host`.
      - [x] **W2** — интерактивный wire (`feat/host-wire`): `/v1/host/{state,submit,stream,
            interrupt,pause,resume,answer}` + `RemoteHost`.
      - [x] **W3a** — сессии/история/лог (`feat/host-read`): `Host.listSessions`,
            `createSession`, `deleteSession`, `getHistory`, `getLog`.
      - [x] **W3b-1** — конфиг/модели (`feat/host-config`): `GET /v1/host/config`,
            `/models`, `runtime/config-view.ts`, `runtime/model-cache.ts`.
      - [x] **W3b-2** — запись конфига (`feat/host-config-write`): `POST /v1/host/config`,
            общий `runtime/config-write.ts`.
      - [x] **W3b-3** — команды (`feat/host-command`): `POST .../command`,
            `Host.executeCommand` → `{ok, output[]}` (серверное подмножество).
      - [x] **W3b-4** — thin-REPL MVP (`feat/daemon-repl`): `mma --daemon <url>`,
            рендер событий, вопросы, локальные `/help|/clear|/exit`.
      - [x] **W3b-5** — картинки (`feat/host-images`): `images` в host submit.
      - [x] **W4a** — web-адаптер (`feat/web-daemon`): `mma web --daemon-url <url>`,
            host-покрытые `/api/*` + SSE-маппинг.
      - [x] **W4b-1** — Files (`feat/web-files`): `/v1/host/files` + `runtime/workspace-fs.ts`.
      - [x] **W4b-2a** — git (`feat/web-git`): `/v1/host/git[/changes|/diff]`.
      - [x] **W4b-2b** — Memory/Skills (`feat/web-memory`): `/v1/host/{memory,skills}`.
      - [x] **W4b-2c** — Setup/Index/LSP (`feat/web-misc`): `/v1/host/{setup,index,lsp,lsp/doctor}`.
      - [x] **W4b-3** — Plugins (`feat/web-plugins`): `/v1/host/plugins`, `runtime/mcp-view.ts`.
      - [x] **W4b-4** — update-панель (`feat/web-update`): updater в `mma serve`,
            `/v1/host/update`, SSE-событие `update`.
      - [x] **W5** — one-shot (`feat/daemon-oneshot`): `mma "prompt" --daemon`
            через job API `/v1/tasks` (+ polling, `remote-tasks.ts`).
      - [x] **W6** — TLS и закалка (`feat/daemon-tls`): `service.tls.*`,
            токен+TLS на не-loopback, `--rotate-token`, фикс образа/`k8s`.
      - [x] **W7** — уборка (`docs/w7-cleanup`): доки, снятые заглушки,
            реестр долгов, синк `docs/README`.

      **Паритет после волн** — `DEBT(daemon-parity-gaps)`: полный каталог
      команд и рендер thin-REPL (plan/usage сделаны; critic/subagent — нет),
      вставка картинок, локаль `X-Mma-Locale`/i18n, e2e «демон + thin-REPL/web».

      **Релиз:** `CHANGELOG`/версия `0.26.0` не трогали; `v0_26_0` не влит в `dev`.
      Обычный `mma web` остаётся in-process; `--daemon-url` — адаптер к демону.
- [x] **Cost/LLM-gateway.** **MVP закрыт 2026-11-09**: per-run hard-stop
      `cost.maxRunUsd` (целые USD; `stopReason=cost_budget` через форс-финал,
      `src/core/agent/cost-budget.ts` + проверка в loop-run). `max_turns`
      hard-stop уже был (`maxToolIterations`), intent-routing кодовая
      (`ProviderManager.pickFor`), cache-anchoring — prefix-monitor (был),
      per-tenant — процессом (silo).
- [x] **MCP/plugin supply-chain.**
      **Закрыто 2026-11-09** тремя ветками: (1) gateway rate-limit
      (`rateLimitMs`, `tool.mcp_rate_limited`) + integrity-манифест скиллов
      (sha256, fail-closed) + SBOM; (2) OAuth 2.1 per-user
      (`src/modules/mcp/oauth.ts`: tokenFile, refresh grant, 401-retry,
      спека `2026-11-09-mcp-oauth-design`); (3) signed-манифесты скиллов
      (Ed25519 `skills-manifest.sig.json` + pubkey, `scripts/sign-skills-manifest.ts`,
      fail-closed при неверной подписи) + spec-синк (`docs/plugins.md`,
      сайт `#mcp`). Disable плагина ≠ sandbox (зафиксировано в `AGENTS.md`).
- [x] **HITL + kill-switch.**
      **Закрыто 2026-11-09** двумя ветками: (1) durable `interrupt()`
      (`interrupt.json` в каталоге сессии, `Agent.pause/resume` персистят,
      рестарт восстанавливает паузу) + глобальный kill-switch
      (`hitl.killSwitch`, стоп на границе итерации); (2) escalation по impact
      (`src/modules/hitl/escalation.ts`: `approve(impact=low|medium|high|critical)`,
      `hitl.autoApproveLow`) + oversight-панель (`GET /v1/oversight`:
      kill-switch, pending-вопросы, audit-валидность, adversarial-хвост;
      регистрация в OpenAPI + гвард `openapi.test.ts`).
- [x] **Поставка и эксплуатация.**
      **Закрыто 2026-11-09** веткой `feat/deployment-ops`: Dockerfile сервиса
      (`deploy/Dockerfile.service`, `mma serve`, HEALTHCHECK), K8s-манифест
      (`deploy/k8s.yaml`: RollingUpdate, probes `/healthz`+`/readyz`,
      least-privilege RBAC Role), `/healthz`+`/readyz` алиасы
      (`/v1/health` остаётся), манифест релиза
      (`bun run build:release-manifest`), откат одной командой
      (`kubectl rollout undo`), SLO + runbook (`deploy/RUNBOOK.md`),
      RBAC/тенанты — silo-процессы + K8s RBAC (silo: 1 процесс = 1 тенант).

### P2 — зрелость

- [x] **Compliance (EU AI Act).**
      **Закрыто 2026-11-09** веткой `feat/compliance-audit`:
      tamper-evident audit-лог (append-only JSONL + hash-chain + HMAC-ключ,
      `src/modules/compliance/audit-log.ts`, верификация `verifyAudit`),
      high-risk артефакты (risk-файл на сессию с tools/approvals/denied,
      lineage model+promptHash, adversarial-лог Art.15 —
      `src/modules/compliance/risk.ts`, oversight-панель читает их через
      `/v1/oversight`), retention ≥6 мес. (`compliance.retentionDays=180`).
      Итого P1+P2 дорожной карты закрыты; открыт только бэклог долгов.
- [x] **Внутренние хвосты.** **Закрыто 2026-11-09**:
      `noExplicitAny` warn→error ratchet'ом (144→0 в `src/`,
      `PlatformHookContext`-контракт + `ctx: any` убраны;
      baseline кастов поднят 36→45→47 осознанно по правилам гейта),
      coverage-threshold в CI (`scripts/coverage-check.ts`, funcs ≥87, lines ≥90),
      остаток раздутых файлов закрыт (`.arch-allowlist.json` пуст).

---

## 4. Бэклог

- [ ] Долги из [`docs/agents/debt.md`](./docs/agents/debt.md) — каждый оплачивается
      по своему триггеру (правило 9). Активных сейчас ~22 записи (реестр сверялся
      2026-10-20; оплата — только вместе с якорем `DEBT(<id>)` и выполненным
      критерием выхода).

---

## 5. Релиз

- Публикация — **только через GitHub Releases** (npm publish не используется).
- Версии в бете — только `0.x.y` (`1.0.0` запрещён, гвард `tests/version-beta.test.ts`).
- Релиз = обновление `CHANGELOG.md` + `package.json` → тег `vX.Y.Z` → GitHub Actions
  (`.github/workflows/release.yml`, артефакты на 5 платформ).
