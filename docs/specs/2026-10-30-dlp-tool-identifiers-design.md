# DLP: идентификаторы тулов неприкосновенны (A11)

Дата: 2026-10-30 · Ветка: `fix/dlp-tool-name-integrity` · Статус: реализовано

## 1. Проблема

Живой лог провайдера:

```
Ошибка LLM API 400 (Bad Request): Upstream request failed:
[invalid_request_error] Invalid 'tools[24].***.name': string does not match pattern.
Expected a string that matches the pattern '^[a-zA-Z0-9_-]+
(request_id 85485dad-8344-4c2f-9b70-3cb46546d8fa)
```

DLP-модуль `security.data-policy` в `EgressGuard.sanitizeChat()` прогонял через
слепой `projectDeep()` **и сообщения, и массив `tools`**. `projectDeep` рекурсивно
редактирует **все** строковые значения, поэтому попадал в `name` дефиниции тула и
в строки JSON-схемы аргументов. Имя тула — структурный идентификатор, по которому
модель вызывает инструмент; после редакции оно перестаёт соответствовать
`^[A-Za-z0-9_-]+$`, и провайдер отклоняет весь запрос.

## 2. Доказанный механизм

Что **доказано**:

1. `projectDeep` редактирует значения `name`. Воспроизведение на реальном контексте
   (Windows, `env.SESSIONNAME=Console`):

   ```
   tools = [{ name: "mcp__playwright__browser_console_messages", description: "console" }]
   projectDeep(tools, policy) →
   [{ "name": "mcp__playwright__browser_<ENV:1eacdc888c98>_messages", ... }]
   ```

2. Причина совпадения: `detectMachine` берёт значения чувствительных env-ключей
   (`SESSIONNAME` входит в `SENSITIVE_ENV_KEYS`), а `findAll` сравнивает
   регистронезависимо. Windows выставляет `SESSIONNAME=Console`, поэтому подстрока
   `console` в имени MCP-тула `browser_console_messages` становится находкой
   класса `env`, а при `pseudonymize: true` (дефолт) — токеном `<ENV:hash>`.

3. Живая сессия `ses_mvuy6zpc_otiooomxxrtseqcx` содержит ровно такой вызов тула:
   `"tool":"mcp__playwright__browser_<ENV:311b74befff0>_messages"`. Токен
   `<ENV:…>` — внутренний формат `TokenMap` этого модуля, то есть имя пришло
   модели уже отредактированным. Это же объясняет, почему на одном провайдере
   запрос проходил (тот не валидировал имя), а на другом — 400.

Что **гипотеза** (логом не доказано):

- Скрытый сегмент `***` в `tools[24].***.name` — это, вероятнее всего,
  `function` (форма OpenAI: `tools[24].function.name`), замаскированный
  upstream-провайдером/шлюзом при формировании текста ошибки. Наш `MASK` в
  телах запросов — `[PATH]`/`[ENV]`/`<PATH:…>`, а `***` встречается в коде
  только в `config/redact.ts` (показ конфига `mma config show` и
  `GET /api/config`), к телу LLM-запроса и к тексту ошибки он не применяется.
  Точный сегмент по логу восстановить нельзя, но он не влияет на вывод:
  невалидным был именно `name` элемента `tools[24]`.

## 3. Целевое поведение (инварианты)

- **INV-DLP-9 (идентификаторы неприкосновенны).** В исходящих tool-definitions
  не редактируются: `name` (включая `function.name`), ключи объектов, имена
  свойств JSON-схемы (`properties`, `patternProperties`, `$defs`, `definitions`).
  Маскируется только свободный текст: `description`, `title`.
- **INV-DLP-10 (схема остаётся валидной).** В схеме аргументов не редактируются
  `enum`, `const`, `pattern`, `format`, `default`, `examples`, `required`,
  `type`, числовые/строковые ограничения и `$ref`/`$id`/`$schema`. Всё, что не
  является описанием или вложенной схемой, сохраняется как есть — «безопаснее
  не редактировать». Если поле всё же редактируется, оно обязано оставаться
  валидным по схеме; поэтому список редактируемого сведён к свободному тексту.
- **INV-DLP-11 (запрос не уходит битым).** После проекции имя каждого тула
  сверяется с исходным. Расхождение восстанавливает исходное имя и порождает
  `GuardDiagnostic` (`kind: "tool-name-integrity"`, `outcome: "passed"`,
  `cause` — путь вида `tools[24].function.name`, без значений). Диагностика с
  `outcome: "passed"` в журнал хода (`turn-journal`) не попадает — это
  техническая запись, а не редакция данных.

## 4. Реализация

- `src/modules/security/data-policy/project-tools.ts` (новый, ≤300 строк):
  - `projectToolDefs(tools, policy)` — проекция массива дефиниций. Поддерживает
    плоскую форму MMA `{name, description, parameters}` и OpenAI-совместимую
    `{type, function: {name, description, parameters}}`. Обходит схему
    структурно: `SCHEMA_MAPS` (имена сохраняются, значения — схемы),
    `SCHEMA_NODES` (вложенные схемы), `FREE_TEXT_KEYS` (редакция), всё
    остальное — как есть.
  - `restoreToolNames(original, projected)` — защитный барьер: возвращает
    исходные имена и список причин.
  - `TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/` — контракт имени провайдера.
- `src/modules/security/data-policy/guard.ts`: `sanitizeChat()` для `tools`
  вызывает `projectToolDefs` + `restoreToolNames` вместо `projectDeep`;
  каждая причина восстановления уходит в `onDiagnostic`.
- `projectDeep` остаётся только для сообщений/произвольных payload'ов
  (`filterClient`), где идентификаторов тулов нет.

Почему отдельная проекция, а не флаг в `projectDeep`: «слепая глубокая редакция»
и «структурная проекция схемы» — разные политики. Флаг внутри общего обходчика
легко потерять при следующем вызове; отдельная функция делает невозможным
применить неверную политику к `tools` по недосмотру.

## 5. Проверки

- `tests/security/dlp-tool-name.test.ts` — падал до правки:
  - OpenAI-форма с именем `browser_console_messages` и путём/секретом в
    `description`: имя и все ключи неизменны, `description` замаскирован,
    `enum`/`pattern`/`default`/`format`/`const`/`required` — байт-в-байт прежние;
  - живой случай `SESSIONNAME=Console` + `mcp__playwright__browser_console_messages`;
  - плоская форма MMA;
  - kill-switch (`enabled=false`) не трогает `tools`;
  - `restoreToolNames` возвращает исходное имя и причину;
  - `sanitizeChat` восстанавливает имя, если проекция его сломала, и пишет
    диагностику `tool-name-integrity`.
- Существующие: `tests/security/data-policy.test.ts`,
  `tests/security/data-policy-secrets.test.ts`,
  `tests/providers/sanitizing-provider.test.ts`,
  `tests/security/guard-diagnostics.test.ts`,
  `tests/security/egress-turn-journal.test.ts`.

## 6. Риски и границы

- `description` тулов по-прежнему маскируется: модель может увидеть `[PATH]`
  вместо реального пути. Это ожидаемая цена политики egress; для доверенного
  (loopback/allowlist) провайдера редакции нет.
- Секреты внутри `enum`/`const`/`default` **не маскируются** осознанно: иначе
  запрос становится заведомо невалидным, а значение аргумента модель и так
  должна взять из схемы. Если такой секрет в схеме есть — это дефект описания
  тула, а не задача DLP.
- Имя тула теперь не маскируется никогда. Плагин/скилл, зарегистрировавший
  имя с путём или PII, «протечёт» им в запрос — но такое имя и так не пройдёт
  валидацию провайдера (`^[A-Za-z0-9_-]+$`). Валидация имён на регистрации
  тулов — отдельная задача (не входит в A11).
