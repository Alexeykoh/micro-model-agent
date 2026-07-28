# План: чистка избыточной сложности в MMA

Проект: **16 049 строк TS, 111 файлов в `src/`** — для агент-лупа с тулзами это многовато.

---

## 0. БАГ: hooks выполняются ДВАЖДЫ
- `loop.ts` (строки 1069, 1300) вызывает `runPreToolUseHooks` / `runPostToolUseHooks` напрямую
- `tool-executor.ts` (строки 228, 291) вызывает их же
- **Хуки бегут дважды на каждый tool call**

---

## 1. Мёртвый код: `react-loop.ts` + тесты
- Помечен `@deprecated`, не импортируется нигде вне тестов

---

## 2. Плагины → hooks (771 строка → ~200)
- PluginManager + PluginLoader + PluginTypes + адаптеры — 771 строка инфраструктуры для 2 тривиальных плагинов
- 14 событий, юзается 3
- `emitModify()` — мёртвый код
- Хардкодные проверки `isActive("lint-on-write")` в loop.ts
- Две параллельные системы перехвата: hooks.ts (shell exec) + PluginManager (async JS)
- **Решение:** удалить PluginManager, переписать 2 плагина как хуки в hooks.ts

---

## 3. subagent: прокладка + дублирование
- `tools/subagent.ts` — реэкспорт из `subagent/*`
- Определение тула продублировано в `definition.ts` и `registry.ts`

---

## 4. System prompt (517 строк) — ~4000-6000 токенов
- TOOL_FORMAT (106 строк) — **дублирует** ToolDefinition из registry.ts
- GROUNDING_RULE (~300 токенов) — мёртвый груз для 90% пользователей
- RULES_COMMON + RULES_FAST — 8 правил идентичны, остальные — вариации
- **Решение:** генерировать TOOL_FORMAT из registry; удалить grounding; объединить rules

---

## 5. loop.ts (1428 строк) — монолит с 26+ ответственностями
- Core ReAct: ~400 строк (28%)
- Остальное: эвристики, фичи, накопленный код
- **На каждый шаг:** до 10 доп. проверок (compact, skills, empty, grounding, plan, stuck, write enforce, syntax, consolidation, error escalation)
- **До 5 доп. LLM-вызовов** на проблемный шаг

**Что вынести:**
- Stuck detection → отдельный модуль
- Grounding check → удалить
- Plan completion audit → в write-enforcer.ts (или удалить)
- Continuation nudges → коллбек
- Read consolidation → в tool-executor.ts
- Syntax check → в tool-executor.ts

---

## 6. Context compaction (context.ts, 301 строка) — субъективный скоринг
- `scoreMessage()`: 50 base + length/recency bonuses — субъективные веса
- compact вызывается на каждом шаге (early return при <50%)
- Emergency compact оставляет 4 сообщения
- **Решение:** скоринг только по важности (system=100, error=90, остальное по позиции); убрать emergency

---

## 7. Memory system (memory.ts, 292 строки) — показывает ТОЛЬКО количество
- 5 файлов: project.md, conventions.md, decisions.md, errors.md, history.md
- `loadAllMemoryDetailed()` возвращает `"conventions: 5 entries\nerrors: 2 entries"` — количество, не содержание
- autoLearnFromError: 8 regex-паттернов
- autoLearnFromEdit: 10 regex-паттернов
- **Решение:** упростить до одного файла с реальным содержимым; удалить autoLearn

---

## 8. User profile (~300 строк) — автосбор без пользы
- Собирает: OS, Node.js, npm, git, Docker, редактор, shell, coding style
- **Решение:** оставить только OS + shell (1-2 строки)

---

## 9. Write enforcer (write-enforcer.ts) — модель обходит
- enforcePlan: блокирует write → модель вызывает subagent → subagent делает write
- enforceWriteStreak: 3 файла → subagent → 3 файла
- **Решение:** оставить только enforceSingleWrite (реально эффективно)

---

## 10. Plan enforcement — fragile regex audit
- Regex-парсинг шагов: `/(Create|Создать)\s+(\S+\.(?:ts|tsx|...))/i`
- existsSync не проверяет поддиректории
- 1-2 доп. LLM-вызова при завершении плана
- **Решение:** убрать audit (проверку файлов); оставить только nudge

---

## 11. Grounding check (~92 строки) — 2-5 доп. LLM-вызовов
- Модель редко соблюдает @grounding маркеры
- **Решение:** удалить целиком

---

## 12. 8 native tools — некоторые сомнительны
- `theme.ts` — модель меняет тему UI? Не нужно
- `scaffold.ts` — CLI-команда, не tool
- `project-map.ts` — дублирует indexer (уже в system prompt)
- **Решение:** удалить theme, scaffold; project-map оставить только как CLI

---

## 13. REPL commands.ts (878 строк) — 23 команды
- read/write/edit/find/search/git — **дублируют инструменты**, которые модель уже имеет
- **Решение:** можно сократить, но не критично

---

## 14. Styling system (4 файла + themes/) — ~400 строк для цветов
- ThemeEngine: 25+ методов (по одному на цвет)
- **Решение:** заменить на простую функцию `color(tag, text)`, а не класс с 25 методами

---

## 15. Config defaults НЕ централизованы
- DEFAULT_CONFIG в `config.ts`
- LLM_DEFAULTS (строки 227-236)
- GROUNDING_DEFAULTS (строки 260-266)
- SPECIALIST_DEFAULTS (строки 287-292)
- Плюс 3 getXxxConfig() функции с дублирующимися ?? операторами
- **Решение:** единый DEFAULT_CONFIG + одна getConfig() функция

---

## 16. Session readable ID (store.ts) — генератор на 90+ слов
- **Решение:** заменить на UUID

---

## Порядок выполнения

1. **Баг-фикс:** убрать двойной вызов hooks
2. **Безопасное удаление:** react-loop.ts, grounding check, readable ID
3. **Плагины → hooks** (самая большая работа, ~771 строка → ~200)
4. **User profile** → минимальный
5. **Memory system** → один файл / удалить autoLearn
6. **Write enforcer** → оставить только singleWrite
7. **Plan enforcement** → убрать audit
8. **Context compaction** → упростить скоринг
9. **System prompt** → генерация из registry
10. **Native tools** → удалить theme, scaffold
11. **Styling** → упростить до функции
12. **Config** → централизовать defaults
13. **Дублирование subagent** → один источник
14. **Реэкспорты** → убрать прокладку
15. **loop.ts** → выделить Stuck detection, Continuation nudges