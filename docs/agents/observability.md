# Наблюдаемость: сигналы fail-open (INV-15)

> Нормативный источник: [architecture v2 §1.4](../specs/2026-10-12-architecture-v2-design.md)
> (INV-13/14/15). Этот документ — **инвентарь fail-open путей**: мест, где
> подсистема по контракту не блокирует ход после отказа. Каждый такой путь
> обязан оставить в `session.jsonl` отдельный сигнал, иначе «сломался» неотличим
> от «сказал ок» — именно это делало разбор боевых сессий ручным (аудит §5.8).

## Формат

Сигнал — запись `SessionLogEntry` с `type` из списка ниже и полями
`Diagnostic` (INV-14): `source`, `operation`, `errorKind`, `cause`
(обязательна при `errorKind !== "ok"`), `recoverable`. Пишется через
`SessionLogger.logDiagnosticEvent(type, diag)`; `content` = `cause`
(совместимо со старыми читателями Trace).

## Инвентарь

| Сигнал | Fail-open путь | Где | Статус |
|---|---|---|---|
| `critic_error` | Критик не дал вердикта (verify бросил или вернул `null`) — ход продолжается как `pass` | `src/core/agent/critic-gate.ts` (`logDegraded`) | ✅ реализовано |
| `tool_attempt` | Хендлер тула бросил исключение; результат деградирован в `success:false`, ход продолжается | `src/core/agent/tool-batch.ts` (`executeCall` catch) | ✅ реализовано |
| `verify_error` | Верификатор деградировал: `validateSyntax` пропускает проверку синтаксиса, когда `tsc` недоступен; LLM-only/неизвестный критерий | `src/modules/execution/verifier.ts` (`validateSyntax`, `verifyCriteria`) | ⬜ открыто — `DEBT(verify-error)` |

### Почему `verify_error` ещё открыт

`StepVerifier` не получает `SessionLogger`: он живёт в `ExecutionModule`, а
`ToolContext` отдаёт модулям только узкий шов `sessionLog: { plan(...) }`
(`src/tools/types.ts`). Чтобы верификатор писал `verify_error`, нужно расширить
шов `sessionLog` диагностическим методом и пробросить его через три точки
сборки контекста (`agent.ts`, `session-phase.ts`, `session-runner-scope.ts`) —
это **правка контракта** `ToolContext`. По правилу 2 AGENTS.md такая правка
получает спеку до кода; поэтому она вынесена из W0.6 отдельным шагом, а не
сделана «заодно».

## Что это не чинит

Сигнал сообщает о деградации, но не меняет поведение fail-open: критик по-прежнему
не блокирует агента, а упавший тул по-прежнему даёт failed-результат. INV-15 — про
**различимость**, а не про запрет деградации.

## Проверки

- `tests/critic-gate.test.ts` — `critic_error` пишется при отказе критика (throw и null).
- `tests/session-logger.test.ts` — `logDiagnosticEvent` персистит форму `Diagnostic`.
- `tests/output/source-filled.test.ts` — источник события непуст (INV-13).
