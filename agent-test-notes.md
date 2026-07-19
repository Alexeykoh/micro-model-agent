# Результаты тестирования агента (режим base)

## Исправлено

### 1. Агент больше не спамит tool_calls после приветствия
- **system-prompt.ts**: убрана инструкция "спроси имя и сохрани", правило на английском
- Правило 12 запрещает list_dir/tree/tool_calls без явной задачи
- **loop.ts**: nudge не срабатывает если агент уже написал ответ

### 2. Агент не упоминает user profile
- Правила 11/9: "Use it silently — never mention or comment on it to the user"

### 3. Авто-загрузка навыков только при реальной работе
- Авто-загрузка @skill срабатывает только если ответ содержит `<tool_call>`
- Описательный текст со `@typescript-expert` больше не триггерит загрузку

### 4. Невалидные tool_call в описательном тексте игнорируются
- Если в ответе > 100 символов текста вне `<tool_call>` — теги считаются примерами

### 5. Empty response после tool_result устранён
- **loop.ts**: после каждого tool result добавляется `Continue.` (user message)
- Модель больше не возвращает пустой ответ — всегда есть nudge продолжать
- Empty response handler теперь safety net (не должен срабатывать)

### 6. Чтение больших файлов чанками (последовательно, без пауз)
- **loop.ts**: обрезка tool result увеличена с 4000 до 8000 символов
- **loop.ts**: добавлена консолидация sequential read_file — последовательные чтения одного файла объединяются в одно сообщение
- **system-prompt.ts**: правило #6 переписано — модель должна предпочитать grep_search вместо последовательных read_file

### 7. grep_search pattern escaping
- **grep-search.ts**: описание pattern улучшено с примерамиescaping (`\\.`, `\\(`, `\\)`)
- **system-prompt.ts**: добавлены regex-примеры в TOOL_FORMAT (`Search with regex`, `Search literal dot`)
- **system-prompt.ts**: правило #5 уточнено — запрещает кавычки в pattern, добавлены инструкции по escaping

### 8. Модель путается при tsconfig-ошибках
- **loop.ts**: добавлено определение config-related ошибок TS (TS17004, TS2307, jsx, moduleResolution)
- **loop.ts**: для config-related ошибок выводится инструкция проверить tsconfig.json вместо "fix the broken line"
- **loop.ts**: pendingSyntaxError блок теперь содержит hint про tsconfig.json

### 9. list_dir вызывается несмотря на запрет
- **system-prompt.ts**: добавлено отдельное правило #12 (RULES_COMMON) и #10 (RULES_FAST) — запрет list_dir/tree для exploration
- **system-prompt.ts**: пример list_dir в TOOL_FORMAT помечен как "(only when user explicitly asks)"

## Результаты тестов

| Сценарий | Результат |
|----------|-----------|
| "tell me about this project" | ✅ Описательный ответ, без tool_calls, без навыков |
| "what is runAgentLoop signature?" | ✅ Прочитал файл grep+read_file, ответил без пустых ответов |
| "find files with 'todo' in src/tools" | ✅ Использовал glob+grep, ответил чётко |
| Упоминание `@skill` в описании | ✅ Не триггерит авто-загрузку |
| User profile в ответе | ✅ Не упоминается |
| Пустые ответы после tool result | ✅ Устранены (Continue. после каждого tool result) |
| Чтение файлов >500 строк | ✅ grep_search-first, консолидация sequential read_file |
| grep_search с regex escaping | ✅ `\\.`, `\\(` работают, кавычки не ломают |
| tsconfig ошибка (jsx) | ✅ Модель получает инструкцию проверить tsconfig.json |
| list_dir без запроса | ✅ Правило #12 запрещает, пример помечен |

## Unit-тесты

| Файл | Тестов | Покрытие |
|------|--------|----------|
| modes.test.ts | 27 | Правила #5, #6, #12; TOOL_FORMAT regex-примеры; list_dir комментарий |
| fs-tools.test.ts | 38 | grep_search escaping (\\. , \\()); sequential read_file chunks |

Все тесты пройдены: 65 (modes + fs-tools) + 90 (base suite) = 155 total.

## Что ещё можно улучшить

- ~~**Чтение больших файлов чанками**~~ ✅ **ПОЧИНЕНО**: обрезка 4K→8K, консолидация sequential read_file, правило #6 grep_search-first.
- ~~**grep_search pattern escaping**~~ ✅ **ПОЧИНЕНО**: описание pattern с примерами, regex-примеры в TOOL_FORMAT, правило #5 уточнено.
- ~~**Модель путается при tsconfig-ошибках**~~ ✅ **ПОЧИНЕНО**: определение config-related ошибок, инструкция проверить tsconfig.json, hint в pendingSyntaxError.
- ~~**list_dir изредка вызывается**~~ ✅ **ПОЧИНЕНО**: отдельное правило #12/#10, пример помечен "(only when user explicitly asks)".
- ~~**Bash на Windows ломает сложные PowerShell команды**~~ ✅ **ПОЧИНЕНО**: `expandBraces()` regex `\{([^{}]+)\}` матчил PowerShell `{ }` блоки и `@{ }` хештаблицы. Новый regex `\{([^{}]*,[^{}]*)\}` трогает только bash-расширения с запятыми. `$` переменные больше не теряются.
