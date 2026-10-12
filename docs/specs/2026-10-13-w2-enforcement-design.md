# W2 — Enforcement: одна точка применения политик тула

**Дата:** 2026-10-13 · **Ветка:** `docs/w2-enforcement-spec` (в рамках architecture v2)
**Статус:** draft
**Нормативная база:** [architecture v2](./2026-10-12-architecture-v2-design.md) §3.4,
INV-9…12 · [аудит](../analysis/2026-10-12-harness-module-audit.md) §4.1, 4.4–4.7

**Причина.** `ToolExecutor.execute()` — заявленная единственная точка enforcement
(AGENTS.md «Enforcement — одна точка»), но сегодня она применяет **только
allowlist и плагин-хуки**. Всё остальное — scope, protected-пути, SSRF,
rate-limit, теги — реализуют **сами хендлеры**: 15 тулов повторяют
`isPathInScope`/`isPathWritable`/`isUrlAllowed`, а `glob` и `bash` не проверяют
ничего. Следствия (аудит):

- проверка живёт в хендлере, а не в точке исполнения → **новый тул забудет** её;
- один и тот же дефект (обход scope/SSRF) повторяется в 4+ тулах;
- отказ неотличим от «тул не умеет» — нет машиночитаемого сигнала (INV-15).

---

## 1. Границы

**Входит:** контракт `ToolSecurityDecl` на `ToolDefinition`, применение
`pathArgs`/`urlArgs`/`caps` в `execute()`, перенос дублирующих проверок из
хендлеров, `bash` под структурный `proc`-гейт.

**Не входит:**
- разбор shell-команд в ядре (перенос `command-validator` в enforcement) —
  остаётся в хендлере `bash` и помечен `manual`;
- `ConfigStore`/эффекты (W3), `core/api` (W4);
- смена набора тегов/сужение тулов (уже есть, `filterToolsByTags`).

---

## 2. Контракт (INV-9…12)

```ts
export type ToolCapability =
  | { fs: "read" } | { fs: "write" } | { fs: "any" }
  | { net: true } | { proc: true } | { interactive: true }
  | { mem: true } | { subagent: true };

export interface ToolSecurityDecl {
  caps: ToolCapability[];
  /** Аргументы-пути: enforcement применяет общий scope + protected-пути. */
  pathArgs?: string[];   // ["path"] | ["from","to"]
  /** Аргументы-URL: enforcement применяет SSRF-политику. */
  urlArgs?: string[];    // ["url"]
  /** Явная отказка от декларации (только особые тулы, видно в `/tools`). */
  manual?: { reason: string; reviewedBy: string; date: string };
}
```

`ToolDefinition` получает **одно** обязательное поле:

```ts
security: ToolSecurityDecl;   // caps обязателен; pathArgs/urlArgs/manual — по потребности
```

Вложенность (а не четыре поля навыворот) выбрана намеренно: декларация — это
один объект политики, `execute()` читает `tool.security.*`, и «нет декларации»
невыразимо по типу.

## 3. Пайплайн `execute()` (до хендлера)

```
allowlist → [pathArgs: isPathInScope + isPathWritable + matchProtectedPath]
          → [urlArgs: isUrlAllowed]
          → rate-limit → плагин-хуки (onBeforeTool) → хендлер
```

- Проверки **fail-closed**: блокировка возвращает `ToolResult{success:false}` с
  `blocked:true` и локализованной причиной (`tool.path_blocked`/`tool.url_blocked`).
- **`caps` — декларация, а не отдельный гейт.** Проверяемые политики привязаны к
  **аргументам**: `pathArgs` (скор + protected) и `urlArgs` (SSRF). `proc`/
  `interactive`/`mem`/`subagent` пока декларативны (видны в `/tools`); центрального
  гейта у них нет, и **нельзя** привязывать их к `security.bash.enabled`/
  `security.network.enabled` — это выключатели **валидации**, не доступа (выключение
  проверки заблокировало бы тул — инверсия смысла). См. правку 2026-10-13 ниже.
- **Согласованность `caps` ↔ аргументы** (гейт): тул с `pathArgs` обязан иметь
  `fs`-cap, тул с `urlArgs` — `net`-cap; иначе декларация врёт о возможностях.
- Теги — не здесь: сужение набора тулов уже делает `filterToolsByTags`.
- `protected-paths` — always-on (не зависит от `security.paths.enabled`).

## 4. Матрица «тул → декларация» (START; полнота обязательна)

| Категория | Тулы | `caps` | `pathArgs` | `urlArgs` |
|---|---|---|---|---|
| файлы-чтение | `read_file`, `list_dir`, `file_info`, `glob`, `grep`, `chunk_query` | `fs:read` | `path`/`dir` (glob — `pattern` не путь) | — |
| файлы-запись | `write_file`, `edit_file`, `create_dir`, `delete_file`, `move_file`, `download_file` | `fs:write` | `path`/`to`/`from` | — |
| сеть | `web_search`, `web_fetch`, `web_browse` | `net` | — | `url`/`query`(нет) |
| процессы | `bash`, `process_list`, `process_log`, `process_kill`, `process_wait` | `proc` | — | — |
| интерактив | `question`, `approve` | `interactive` | — | — |
| сабагент/план | `subagent`, `plan`, `plan_step`, `todo`, `verify`, `pipeline_run` | `subagent`/`[]` | — | — |
| прочее | `search_history`, `attach_image`, `session_info`, `meet_done`, `define_capability`, `enable_tools`, `load_skill`, `mcp_call` | по домену | — | — |

Полнота закрывается **гейтом**: каждый тул в реестре должен иметь
`caps` и (при `manual` — `reason`).

**`bash` (решение).** `pathArgs` неприменим (команда, не путь). Декларация:
`caps:[{proc:true}]` + `manual:{reason:"shell — command-validator в хендлере", …}`.
Валидация строки остаётся в хендлере и честно помечена. Отдельного
`proc`-гейта в `execute()` **нет**: `security.bash.enabled` — выключатель
*валидации*, а не доступа (правка 2026-10-13, см. §3).

**Правка 2026-10-13.** Исходная версия привязывала `proc`/`net` к
`security.bash.enabled`/`security.network.enabled`. Это ошибка: оба ключа —
«master switch for … validation / outbound checks» (i18n), то есть при
`false` они отключают **проверку**, а не сам доступ. Привязка тулов к ним
заблокировала бы тул при выключенной проверке — инверсия. Центрального
«фича-выключателя» для сети/шелла в конфиге сейчас нет, поэтому W2.4 сведён к
**согласованности `caps` ↔ аргументов** (гейт), а не к мнимому гейту.

## 5. Задачи и порядок

| # | Задача | Проверка |
|---|---|---|
| W2.1 | Типы `ToolCapability`/`ToolSecurityDecl` + поле `security` в `ToolDefinition`; объявить для всех встроенных и модульных тулов | гейт формы `tests/tools/security-decl.test.ts` |
| W2.2 | `pathArgs` в `execute()` (scope + writable + protected) + тесты обхода | `tests/tools/enforcement-path.test.ts` ✅ |
| W2.3 | `urlArgs` в `execute()` (SSRF) + тесты | `tests/tools/enforcement-url.test.ts` ✅ |
| W2.4 | Согласованность `caps` ↔ `pathArgs`/`urlArgs` (гейт); правка `caps`-мэппинга | `tests/tools/security-decl.test.ts` |
| W2.5 | Снять дублирующие проверки из хендлеров (оставить доменную валидацию) | существующие security-тесты зелёные ✅ |

Порядок: W2.1 (объявления) → W2.2/W2.3 (точка) → W2.4 (согласованность) → W2.5 (чистка).

## 6. Риски

- **Двойная блокировка** на переходе (хендлер + `execute`): одинаковый отказ, но
  разные тексты → тесты сверяют поведение, а не строку; W2.5 убирает дубль.
- **`glob`/`grep`**: `pattern` — не путь; результат-пути фильтровать в хендлере
  (как сейчас), а `pathArgs` объявлять только для реального аргумента-пути.
- **Rate-limit** — глобальный синглтон (см. W1 §4.1); в W2 только подключаем
  вызов, per-session — вне границ.
- Совместимость: `caps` обязателен → правка всех тулов; делается W2.1 целиком,
  чтобы гейт полноты сразу был строгим.

## 7. Что НЕ делаем

- Не парсим shell в ядре.
- Не меняем семантику scope/SSRF-политик — только переносим вызов в одну точку.
- Не вводим динамическую переконфигурацию enforcement (W3).
