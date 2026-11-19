# Вкладка «Плагины»: только плагины, модули харнесса не отключаются

_Дата: 2026-10-29. Ветка: `fix/stress-register`. Источник: обратная связь
пользователя по `mma web`._

**Статус:** реализовано (`22e5aebe`); гварды `tests/modules/plugins/system-plugins.test.ts`, `tests/webui-plugins-system.test.ts` зелёные.

## Что показала проблема (наблюдение)

Вкладка «Плагины» показывала 10 записей, из которых 7 — хуки модулей
харнесса (`execution`, `session`, `indexer`, `mcp_module`, `browser`, `skills`,
`lsp-check`). Они выглядели как обычные плагины и имели тумблеры. Отключение
такой «записи» не выгружает код (модуль уже `require`-нут) и меняет поведение
ядра — например, «disable session» ломает сессии, а не удаляет плагин.

Пользовательские плагины — только внешние (`source: global|project`) и
опциональные встроенные (`notify`, `lint-on-write`, `angular11`).

## Решение

1. **Признак `system`.** `registerBuiltinPlugin()` (хуки модулей) ставит
   `plugin.system = true`; `PluginRecord` получает `system: boolean`.
2. **UI показывает только пользовательские плагины.** Вкладка «Плагины»
   фильтрует `system`, наверху — строка «встроенных модулей харнесса: N — они
   не плагины и не отключаются». Тумблеров у них нет.
3. **Отключение системного модуля запрещено на сервере и в CLI.**
   `PluginManager.setEnabled(name, false)` возвращает `false` для `system`;
   `setDisabledAll()` игнорирует системные имена (старый конфиг
   `plugins.disabled` с `session` самолечится); `POST /api/plugins/:name`
   отдаёт `409 {error:"system"}`; `mma plugins disable <core>` завершается
   кодом 1 с объяснением.
4. **`plugins list -a`** по-прежнему показывает все записи (для диагностики),
   но `disable` для `system` не работает.

## Инварианты

- **INV-P1.** `system`-запись не отключается ни одним путём: UI, API, CLI,
  конфиг. Проверки: `tests/modules/plugins/system-plugins.test.ts`.
- **INV-P2.** Вкладка «Плагины» не рисует строку/тумблер для `system`; счётчик
  и пустое состояние считают только пользовательские. Проверка:
  `tests/webui-plugins-system.test.ts`.
- **INV-P3.** Опциональные встроенные (`notify`, `lint-on-write`, `angular11`)
  остаются пользовательскими и отключаются как раньше.

## Тесты

| файл | что держит |
|---|---|
| `tests/modules/plugins/system-plugins.test.ts` | records/system, запрет disable, фильтр deny-list |
| `tests/webui-plugins-system.test.ts` | системные скрыты, пользовательские видны, счётчик |

## План

1. `system` в типе/регистрации/записи + запрет в менеджере и API/CLI.
2. Фильтр и пояснение в вкладке «Плагины».
