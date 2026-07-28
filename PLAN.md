# Grounding-система для борьбы с галлюцинациями

## Проблема
Qwen 3.5 4B/9B и другие маленькие модели начинают галлюцинировать при перегрузке контекста:
- ссылаются на несуществующие файлы
- забывают имя пользователя, задачу, правила
- генерируют синтаксически верный, но семантически неверный код

## Решение: 3 этапа

### Этап B — Grounding-токен (проверка заземления контекста)
**Цель:** Ранний детектор потери контекста — модель обязана выводить маркер `@grounding` перед каждым `<tool_call>`.

**Что делаем:**
1. **system-prompt.ts:**
   - Добавить константу `GROUNDING_RULE` с инструкцией выводить `@grounding[файл: <target-path>]` перед каждым tool_call
   - Включить её в `RULES_COMMON` и `RULES_FAST` (или в platformBlock)
2. **loop.ts:**
   - После парсинга tool calls (строка ~590) проверять наличие `@grounding[...]` в ответе
   - Если отсутствует → `consecutiveMissingGrounding++`, мягкое напоминание (push reminder message, continue)
   - Если повторно отсутствует (>=3) → retry LLM с подсказкой
   - Если присутствует, но путь не совпадает с аргументами tool_call → предупреждение

### Этап A — Pre-flight валидация путей файлов
**Цель:** Не дать модели выполнять tool_call с несуществующими файлами.

**Что делаем:**
1. **tool-executor.ts:**
   - Перед выполнением FS-тулов (read_file, write_file, edit_file, file_info, delete_file, copy_file, move_file) проверять, что путь существует на диске
   - Если путь не существует → вернуть `ToolResult` с ошибкой `ENOENT` и инструкцией проверить путь
   - Исключение: write_file/create_dir — создают новые файлы, для них проверять только родительскую директорию

### Этап D — Конфигурация grounding
**Цель:** Вынести настройки grounding в конфиг для гибкости.

**Что делаем:**
1. **config/types.ts:** Добавить интерфейс `GroundingConfig` и поле `grounding` в `AgentConfig`
2. **config/config.ts:** Добавить DEFAULT_GROUNDING_CONFIG в DEFAULT_CONFIG.agent
3. **loop.ts:** Читать grounding config, передавать в проверки
4. **cli/config.ts, setup-wizard.ts:** Синхронизировать дефолты

## Структура конфига
```typescript
interface GroundingConfig {
  enabled?: boolean;           // Включить grounding-проверки (default: true)
  strictMode?: boolean;        // strict=retry LLM, false=только reminder (default: false)
  checkFiles?: boolean;        // Pre-flight валидация путей (default: true)
  maxMissingGrounding?: number; // Сколько раз можно пропустить токен до retry (default: 3)
}
```

## Файлы для изменений

| Файл | Этап | Изменения |
|------|------|-----------|
| `src/agent/system-prompt.ts` | B | Добавить GROUNDING_RULE, включить в rules |
| `src/agent/loop.ts` | B, D | Проверка grounding-токена, чтение конфига |
| `src/agent/tool-executor.ts` | A | Pre-flight проверка путей |
| `src/config/types.ts` | D | GroundingConfig интерфейс |
| `src/config/config.ts` | D | DEFAULT_GROUNDING_CONFIG |
| `src/cli/config.ts` | D | Синхронизация дефолтов |
| `src/setup-wizard.ts` | D | Синхронизация дефолтов |