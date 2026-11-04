# Final typecheck gate without a plan — design

> **Дата:** 2026-11-03. Закрывает долг F-21 (TODO §1.12).

## Проблема

`typecheckFailures` блокировал только `plan_step done`. Если плана нет,
модель могла завершить ход с красным `tsc` и ответом «готово».

## Контракт

`FinalAuditHost` получает `typecheckFailures: ReadonlyMap<string, string>`
(заполняется execution-плагином из write/edit, очищается чистым результатом).

`runFinalAudit`:
- план есть → прежнее поведение;
- плана нет и карта пуста → `null` (аудита нет);
- плана нет и карта непуста → `passed:false`, `summary` «project typecheck
  failed in N file(s)», файлы — в `pendingSteps`.

`AuditGate` обрабатывает результат как обычный неполный аудит: repair-цикл,
затем `auditFailed`/`success:false` по `MAX_AUDIT_RETRIES`.

## Гейты

`tests/modules/execution/final-typecheck-gate.test.ts` (провал с файлом,
`null` при пустой карте), существующие `tests/core/agent-audit-gate.test.ts`.
