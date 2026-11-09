# `health()` для шести подсистем (оплата `observability-health-coverage`)

## Проблема

`health()` подсистем (§3.6 спеки observability) не реализован: у `lsp`, `mcp`,
`browser`, `indexer`, `skills`, `memory` нет `health()`. `ModuleHost.health()`
отдаёт для них `ok` по умолчанию (`module-host.ts:238`), поэтому `mma doctor`
зелёный при мёртвой подсистеме. Гейта `tests/arch/health-coverage.test.ts`
из §5 спеки нет.

## Решение

Каждый из шести модулей отдаёт честный `health()` из реального сигнала
(не константный `ok`):

- **lsp** — `LspHealth.blocked()`: серверы на паузе восстановления →
  `degraded` с ключами и `retryInMs`.
- **mcp** — `failedServers`: серверы, упавшие в discovery → `degraded` со списком.
- **browser** — проба Chromium в `setup()` (`isChromiumInstalled()`); не установлен →
  `degraded` с командой установки; установлен → `ok`.
- **indexer** — итог последней `buildIndex()`: неустранимая ошибка стройки →
  `degraded` с причиной; индекс построен → `ok`.
- **skills** — ошибка пересканирования в `reload()`: недавняя ошибка →
  `degraded`; иначе `ok` (ноль скиллов — не failure, это норма).
- **memory** — читаемость стора (`getPreferences()` в try/catch): исключение →
  `degraded` с причиной; иначе `ok`.

`ModuleDef.health` в `*/lifecycle.ts` пробрасывает `health()` модуля.
Гейт `tests/arch/health-coverage.test.ts`: падает, если один из шести
lifecycle-файлов не объявляет `health:` или класс модуля не имеет метода
`health()`. Юнит-тесты `tests/modules/health-coverage.test.ts` проверяют
degraded-ветки на стабах.
