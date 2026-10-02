# Session-Scope Isolation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline) or
> superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Убрать кросс-сессионные утечки (логи, аудит, поток вывода, процессы,
identity провайдера) и разрушительный авто-прунинг, чтобы параллельные раннеры
`mma web` были изолированы. Фундамент для web-состояния (план B).

**Architecture:** Ввести явный `SessionScope` (logger/audit/outputTag/
providerIdentity/processRegistry), передаваемый main и каждому раннеру;
убрать сессионно-зависимые модуль-глобалы.

**Tech Stack:** Bun + TypeScript strict, vitest (`bun test`), i18n en/ru.

**Спека:** [docs/specs/2026-10-02-session-scope-isolation-design.md](../specs/2026-10-02-session-scope-isolation-design.md)
**Ветка:** `feat/session-scope-isolation` (создать от актуального `master`).
**Базовая линия:** `tsc --noEmit` — 0 ошибок; web-тесты сессий — 52 pass.

> **Статус (2026-10-02, ветка `feat/session-scope-isolation`): ВСЕ P0 закрыты.**
> P0-1 per-session `Logger.forSession` + session-scoped audit-dir; P0-2 owning
> session id прокинут в LLM-вызовы (`ChatOptions.sessionId` → `x-opencode-session`/
> `prompt_cache_key`/`session_id`; main loop, overflow-суммаризация, LLM-судья,
> chunk_query); P0-3 `OutputEvent.sessionId` + маршрутизация Trace по своей
> вкладке; P0-4 `create` не прунит пустые; P0-5 busy-gate записи конфига;
> P0-6 session-scoped kill-реестр процессов.
> Проверка: `bun test` 2995 pass / 6 skip / 0 fail, `bun run quality`
> (typecheck + lint + fallow) зелёный.
> Дальше — план B (`docs/plans/2026-10-02-web-session-state.md`), смыкает
> per-tab projection и подписки.

---

## Phase 0: Тестовая сеть (без неё дальше вслепую)

### Task 0.1: Конкурентный тест изоляции (red)

**Files:**
- Create: `tests/session-scope-isolation.test.ts`

- [ ] **Step 1: Написать падающий тест**

Сценарий: два `SessionRunner` (через фабрику-стаб или реальную фабрику с
мок-агентом) стартуют ход одновременно; проверить, что
`FileLogWriter` каждой сессии содержит только её строки и `_sessionAuditDir`
не переключён в чужой каталог.

```ts
it("two concurrent sessions keep file logs and audit dirs separate", async () => {
  // arrange: temp config dir, two sessions A/B, instrument logger writes
  // act: bindSessionDir for A and B (interleaved), write marker lines
  // assert: A's log file has only A markers, B's only B
});
```

- [ ] **Step 2: Запустить — падает**

Run: `bun test tests/session-scope-isolation.test.ts`
Expected: FAIL (текущая реализация перевешивает общий sessionLogPath).

### Task 0.2: Тест provider identity (red)

**Files:**
- Create: `tests/llm/provider-session-identity.test.ts`

- [ ] **Step 1: Тест на моке `fetch`**: при ходе раннера сессии X заголовок
  `x-opencode-session` (и `prompt_cache_key`) равны X, не main-сессии.

- [ ] **Step 2: Run:** `bun test tests/llm/provider-session-identity.test.ts`
  Expected: FAIL.

### Task 0.3: Тест `OutputEvent.sessionId` (red)

**Files:**
- Modify: `tests/webui-log-forward.test.ts`

- [ ] **Step 1:** тест: событие с `sessionId: B` не появляется в ленте/Trace
  активной сессии A (после реализации 4.2).

- [ ] **Step 2: Run:** `bun test tests/webui-log-forward.test.ts` Expected: FAIL.

### Task 0.4: Commit

```bash
git add tests/session-scope-isolation.test.ts tests/llm/provider-session-identity.test.ts tests/webui-log-forward.test.ts
git commit -m "test(session-scope): red tests for cross-session isolation"
```

---

## Phase 1: Логирование и аудит (P0-1)

### Task 1.1: `OutputEvent.sessionId` — тип

**Files:**
- Modify: `src/output/types.ts`

- [ ] **Step 1:** Добавить `sessionId?: string;` в `OutputEvent` с JSDoc
  (проставляет продюсер; отсутствие = legacy).
- [ ] **Step 2: Run:** `tsc --noEmit` Expected: PASS.

### Task 1.2: Раннер получает собственный logger

**Files:**
- Modify: `src/core/bootstrap/session-runner.ts`
- Modify: `src/logger/app-logger.ts` (если нужен параметр сессии в `child()`)
- Modify: `src/core/session-logger.ts`

- [ ] **Step 1:** Раннер создаёт `logger.child({ sessionId })` и передаёт в
  `assembleRunnerAgent` как `logger`; `SessionLogger` больше не зовёт
  `logger.setSessionDir/initSessionLog` на shared инстансе, а пишет через
  сессионный logger.
- [ ] **Step 2:** Аудит: заменить `setAuditSessionDir(dir)` на передачу `dir`
  в session-скопе; убрать глобальное переключение (проверить всех
  потребителей `auditLogFile`).
- [ ] **Step 3: Run:** `bun test tests/session-scope-isolation.test.ts tests/session-logger.test.ts tests/session-logging.test.ts`
  Expected: PASS.
- [ ] **Step 4: Commit**

```bash
git add src/core/bootstrap/session-runner.ts src/logger/app-logger.ts src/core/session-logger.ts src/modules/security/audit-log.ts
git commit -m "fix(logging): per-session logger and audit dir (no shared mutation)"
```

### Task 1.3: Продюсеры проставляют `sessionId` в OutputEvent

**Files:**
- Modify: `src/logger/app-logger.ts`, `src/output/bus.ts`, `src/modules/webui/log-forward.ts`

- [ ] **Step 1:** Логгер, привязанный к сессии, кладёт `sessionId` в `data`/поле
  события; `log-forward` фильтрует по подписанной сессии, если поле есть.
- [ ] **Step 2: Run:** `bun test tests/webui-log-forward.test.ts tests/output` Expected: PASS.
- [ ] **Step 3: Commit**

```bash
git add src/logger/app-logger.ts src/output/bus.ts src/modules/webui/log-forward.ts
git commit -m "fix(output): tag sessionId and filter cross-session log events"
```

---

## Phase 2: Identity провайдера (P0-2)

### Task 2.1: Раннер строит провайдер со своей сессией

**Files:**
- Modify: `src/core/bootstrap/session-runner.ts`
- Modify: `src/modules/providers/manager.ts`/`factory.ts` (если sessionId на build)
- Test: `tests/llm/provider-session-identity.test.ts`

- [ ] **Step 1:** Выбрать путь: (a) `ProviderManager.build(sessionId)` для
  раннера, либо (b) после `assembleRunnerAgent` вызвать
  `agent.reconfigure(config)` (уже корректный `getSessionId` из
  `agent.ts:1562-1563`) и убедиться, что toolCtx/executor получили новый
  провайдер.
- [ ] **Step 2: Run:** `bun test tests/llm/provider-session-identity.test.ts tests/providers` Expected: PASS.
- [ ] **Step 3: Commit**

```bash
git add src/core/bootstrap/session-runner.ts src/modules/providers
git commit -m "fix(provider): per-session provider identity for runners"
```

---

## Phase 3: Процессы (P0-6)

### Task 3.1: Kill-реестр с session-скоупом

**Files:**
- Modify: `src/modules/processes/runner.ts`
- Modify: `src/tools/bash.ts`
- Modify: `src/tools/executor.ts` (передать scope)
- Test: `tests/tools/bash*.test.ts` / новый

- [ ] **Step 1:** `registerKillable(scope, callId, kill)` / `killByCallId(scope, callId)`;
  ключ — `sessionId + callId`.
- [ ] **Step 2: Run:** `bun test tests/tools` Expected: PASS.
- [ ] **Step 3: Commit**

```bash
git add src/modules/processes/runner.ts src/tools/bash.ts src/tools/executor.ts
git commit -m "fix(processes): session-scoped kill registry"
```

---

## Phase 4: Жизненный цикл сессий (P0-4)

### Task 4.1: Убрать `pruneEmpty` из `create`

**Files:**
- Modify: `src/modules/session/manager.ts`
- Modify: `src/cli/commands.ts` / `src/cli/repl-commands.ts` (если нужен явный prune)
- Test: `tests/session-manager.test.ts`

- [ ] **Step 1:** Удалить вызов `this.pruneEmpty(id)` из `create`; авто-прунинг —
  отдельная команда `session prune` (CLI/web) с явным вызовом.
- [ ] **Step 2: Run:** `bun test tests/session-manager.test.ts tests/webui-server.test.ts` Expected: PASS.
- [ ] **Step 3: Commit**

```bash
git add src/modules/session/manager.ts src/cli/commands.ts src/cli/repl-commands.ts tests/session-manager.test.ts
git commit -m "fix(session): stop pruning empty sessions on create"
```

---

## Phase 5: Управляющие команды (P0-5)

### Task 5.1: Busy-gate / адресный reconfigure

**Files:**
- Modify: `src/modules/webui/actions-api.ts`
- Modify: `src/modules/webui/reconfigure.ts`
- Test: `tests/webui-server.test.ts`, `tests/webui-reconfigure.test.ts`

- [ ] **Step 1:** Решение (зафиксировать в спеке): при busy `/api/command`,
  меняющая конфиг, не трогает живой раннер — применяется к новым/простаивающим,
  активный подхватит на следующем `turn_end`. Либо 409 с подсказкой.
- [ ] **Step 2:** `reconfigure` пропускает busy-раннеры.
- [ ] **Step 3: Run:** `bun test tests/webui-server.test.ts tests/webui-reconfigure.test.ts` Expected: PASS.
- [ ] **Step 4: Commit**

```bash
git add src/modules/webui/actions-api.ts src/modules/webui/reconfigure.ts
git commit -m "fix(webui): safe reconfigure and busy-gate for commands"
```

---

## Phase 6: Финал

### Task 6.1: Документация и проверка

**Files:** `AGENTS.md`, `CHANGELOG.md`

- [ ] **Step 1:** AGENTS.md — раздел о session-scope изоляции.
- [ ] **Step 2: Полный прогон:** `bun run quality` (typecheck + lint + fallow) + `bun test`.
- [ ] **Step 3: Commit**

```bash
git add AGENTS.md CHANGELOG.md
git commit -m "docs: session-scope isolation"
```

---

## Приёмка

- [ ] Все P0 из спеки закрыты acceptance-тестами.
- [ ] REPL-поведение не изменилось (регресс-прогон).
- [ ] `bun run quality` зелёный.
- [ ] Ветка смержена после ревью; план B продолжается от обновлённого `master`.
