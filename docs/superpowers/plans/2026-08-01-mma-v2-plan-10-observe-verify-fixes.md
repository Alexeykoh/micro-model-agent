# Plan 10: Fix plan — Observability, Plan Persistence, Verification, Context Accounting

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Устранить 5 корневых причин, найденных при расследовании сессии `ses_msa53vs8_4elcpu` (`E:\mma_test`, модель `north-mini-code-1.0`): (1) чтение файлов целиком без указания пути, (2) потеря/перезапуск плана, (3) «завершение» без верификации, (4) отсутствие AST/LSP-проверок на выходе, (5) эвристическая оценка токенов контекста.

**Источник расследования:** см. `docs/testing/observations.md` (шаблон OBS) — запись OBS-005 будет добавлена после реализации.

**Tech Stack:** Bun + TypeScript, vitest. TDD по AGENTS.md (тест → реализация → коммит).

---

## File Structure

```
src/core/
  agent.ts            — MODIFY: вывод пути тула, инжекция плана в контекст, финальная верификация перед завершением
  prompt-builder.ts   — MODIFY: поддержка динамического refresh блоков
  bootstrap.ts        — MODIFY: ре-коллекция promptBlocks после создания execution-модуля

src/tools/
  read-file.ts        — MODIFY: чанкинг по умолчанию (limit), вывод пути+формата в result
  plan.ts             — MODIFY: действие show (вывод статуса плана в контекст)

src/modules/execution/
  module.ts           — MODIFY: вызов Auditor в конце run, инжекция плана в promptBlocks
  auditor.ts          — MODIFY: поднять статус из мёртвого кода в реальный вызов
  planner.ts          — MODIFY: сериализация плана в PromptBlock (checklist)

src/modules/context/
  manager.ts          — MODIFY: реальный подсчёт токенов (js-tiktoken), мягкая компакция

src/llm/
  token-counter.ts    — MODIFY: сделать доступным/переиспользуемым для ContextManager

src/modules/plugins/builtin/
  lint-on-write.ts    — MODIFY: не фильтровать "Cannot find module", батч-проверка проекта

tests/
  tools/read-file.test.ts       — NEW
  modules/context/manager.test.ts — MODIFY
  core/agent.test.ts            — MODIFY
```

---

## Task 1: read-file — чанкинг по умолчанию + полный путь в выводе

**Проблема:** `read-file.ts` без `offset`/`limit` возвращает весь файл (`read-file.ts:38-39`). В терминале у карточки тула только friendly-метка «Чтение файла», без аргумента `path` (`agent.ts:274-279`) — не видно, какой файл и какого формата читается. У `write-file`/`edit-file` путь выводится, у `read-file` — нет.

**Файлы:**
- Modify: `src/tools/read-file.ts`
- Modify: `src/core/agent.ts` (форматирование карточки тула)
- Test: `tests/tools/read-file.test.ts`

- [ ] **Step 1: Тест на чанкинг по умолчанию**

```typescript
// tests/tools/read-file.test.ts — NEW
// 1. Создать файл > defaultLimit строк (например 1000)
// 2. Вызвать read_file без offset/limit
// 3. Expect: вернул только первые defaultLimit строк, output содержит указание
//    "файл длиннее limit — чтение обрезано, вызовите повторно с offset=<N>"
// 4. Expect: output содержит полный путь файла и формат (расширение)
```

- [ ] **Step 2: Реализовать чанкинг**

`src/tools/read-file.ts` — установить `defaultLimit` (предложить 300 строк), добавлять суффикс с информацией о продолжении, выводить `path` и расширение в первый блок результата.

- [ ] **Step 3: Реализовать вывод пути в карточке тула**

`src/core/agent.ts` — в `summarizeArgs`/карточку тула добавить аргументы `path`/`offset`/`limit` (по аналогии с write/edit).

- [ ] **Step 4: Прогнать тесты**

Run: `bun test tests/tools/read-file.test.ts` → pass; `bun test` → без регрессий; `tsc --noEmit` → 0 ошибок.

- [ ] **Step 5: Commit**

```bash
git add src/tools/read-file.ts src/core/agent.ts tests/tools/read-file.test.ts
git commit -m "fix: read-file chunking + show full path in tool card"
```

---

## Task 2: План в контексте LLM + `plan show` + ре-коллекция promptBlocks

**Проблема:** план-чеклист уходит только в `display` (терминал), в контекст модели попадает короткая строка «План создан: …». Тула `plan` нет действия `show` (`execution/module.ts:64`). `promptBlocks` собираются один раз при bootstrap (`bootstrap.ts:356-360`), когда execution-модуль ещё не создал трекер плана. В сочетании с агрессивной компакцией (`KEEP_LAST_N=6`) модель забывала и план, и текст задачи → перезапуск плана с начала.

**Файлы:**
- Modify: `src/tools/plan.ts`
- Modify: `src/modules/execution/module.ts`
- Modify: `src/modules/execution/planner.ts`
- Modify: `src/core/prompt-builder.ts`
- Modify: `src/core/bootstrap.ts`
- Modify: `src/core/agent.ts` (refresh блоков перед вызовом LLM)
- Test: `tests/core/agent.test.ts`

- [ ] **Step 1: Тест: блок плана в системном промпте**

1. Запустить `Agent.run()` с execution-модулем
2. Вызвать `plan` тул (создать план)
3. Expect: на следующей итерации `system` промпт содержит чеклист плана `[ ]`/`[x]`

- [ ] **Step 2: Сериализация плана в PromptBlock**

`planner.ts` — функция `planToPromptBlock(tracker): PromptBlock` (id: `execution.plan`, priority ниже системных блоков), рендерит шаги как checklist.

- [ ] **Step 3: Инжекция при каждом LLM-вызове**

`agent.ts` — перед `llmProvider.chat()` пересобирать `promptBlocks` (или запрашивать блок плана у модулей заново); `prompt-builder.ts` — поддержка refresh (метод `setBlocks`/`updateBlock`).

- [ ] **Step 4: `plan show`**

`plan.ts` — добавить action `show`: возвращает текущий статус плана (шаги, выполнено/в работе/осталось) в результат тула.

- [ ] **Step 5: Ре-коллекция в bootstrap**

`bootstrap.ts` — собрать `promptBlocks` после регистрации всех модулей (execution включён), либо сделать коллекцию динамической на старте `run()`.

- [ ] **Step 6: Тесты + typecheck**

Run: `bun test tests/core/agent.test.ts`; `bun test`; `tsc --noEmit` → 0 ошибок.

- [ ] **Step 7: Commit**

```bash
git add src/tools/plan.ts src/modules/execution/ tests/core/agent.test.ts src/core/prompt-builder.ts src/core/bootstrap.ts src/core/agent.ts
git commit -m "fix: inject plan checklist into LLM context, add plan show action"
```

---

## Task 3: Финальная верификация перед завершением (Auditor)

**Проблема:** цикл завершается при первом ответе без tool_call (`agent.ts:528-529`), не проверив выполнение плана. `Auditor` (`execution/module.ts:30`) — мёртвый код, никогда не вызывается. `verify`-тул модель ни разу не вызвала. План не был выполнен, но агент сказал «закончил».

**Файлы:**
- Modify: `src/modules/execution/module.ts`
- Modify: `src/modules/execution/auditor.ts`
- Modify: `src/core/agent.ts`
- Test: `tests/core/agent.test.ts`

- [ ] **Step 1: Тест: незавершённый план не даёт завершиться**

1. План с шагами A, B
2. Модель делает шаг A, затем возвращает финальный текст без tool_call
3. Expect: агент НЕ завершается сразу — вызывает auditor, возвращает предупреждение с невыполненными шагами (success: false или текст-предупреждение)

- [ ] **Step 2: Вызов Auditor в конце run**

`agent.ts` — перед выходом из цикла (когда нет tool_call) вызывать `auditor.run()`, если план активен: проверить все ли шаги выполнены. Если нет — вернуть результат с `pendingSteps` и рекомендацией продолжить.

- [ ] **Step 3: Публичная проверка артефактов**

`auditor.ts` — расширить: проверка существования созданных файлов + `tsc --noEmit`/`npm run build` (см. Task 4) + статус шагов плана.

- [ ] **Step 4: Тесты + typecheck**

Run: `bun test tests/core/agent.test.ts`; `bun test`; `tsc --noEmit` → 0 ошибок.

- [ ] **Step 5: Commit**

```bash
git add src/modules/execution/module.ts src/modules/execution/auditor.ts src/core/agent.ts tests/core/agent.test.ts
git commit -m "fix: run auditor before final answer, block completion with pending steps"
```

---

## Task 4: AST/LSP-проверки проекта перед завершением

**Проблема:** проект вышел нерабочим: `vite.config.ts` задаёт `root: 'src'` + `input: 'index.html'`, но `index.html` записан в корень, а не в `src/`; `react` добавлен в deps позже, чем записаны `main.tsx`/`App.tsx`. `tsc`/`vite build`/`npm run build` агентом не запускались. `lint-on-write` фильтрует `Cannot find module` (строка 47) и гоняет tsc по одному файлу — межфайловые ошибки не видны.

**Файлы:**
- Modify: `src/modules/plugins/builtin/lint-on-write.ts`
- Modify: `src/modules/execution/auditor.ts` (подключение)
- Test: через Task 3 + ручной сценарий

- [ ] **Step 1: Тест: `Cannot find module` не фильтруется**

Юнит-тест на парсер вывода tsc: вывод с `Cannot find module 'react'` должен попадать в результат lint-on-write, а не отбрасываться.

- [ ] **Step 2: Убрать фильтр и добавить проектную проверку**

`lint-on-write.ts` — убрать фильтрацию `Cannot find module`; после `write_file`/`edit_file` в проекте с `tsconfig.json`/`package.json` запускать проектную проверку (`tsc --noEmit --skipLibCheck` по всему проекту, при наличии `build`/`typecheck` script — его). Результат — в tool result (модель чинит сразу), перф-ограничение: кеш/дебаунс, не на каждый write при больших проектах.

- [ ] **Step 3: Включить в Auditor**

`auditor.ts` — финальный прогон проектной проверки перед ответом; при ошибках — вернуть их списком модели для исправления.

- [ ] **Step 4: Тесты + typecheck**

Run: `bun test`; `tsc --noEmit` → 0 ошибок.

- [ ] **Step 5: Commit**

```bash
git add src/modules/plugins/builtin/lint-on-write.ts src/modules/execution/auditor.ts
git commit -m "fix: project-wide typecheck on write + auditor, surface Cannot find module"
```

---

## Task 5: Настоящий подсчёт токенов в ContextManager

**Проблема:** оценка токенов эвристикой `content.length / 2` (`context/manager.ts:75-86`); реальный `TokenCounter` (js-tiktoken) используется только в `openai-compat`. После компакции контекст отображался как 1522/24577 = 6% — пользователь видит «подозрительно малый контекст». Плюс агрессивная компакция `KEEP_LAST_N=6` (маленький интервал 15) съедала историю вместе с планом.

**Файлы:**
- Modify: `src/llm/token-counter.ts`
- Modify: `src/modules/context/manager.ts`
- Modify: `src/core/bootstrap.ts` (проброс TokenCounter)
- Test: `tests/modules/context/manager.test.ts`

- [ ] **Step 1: Тест: подсчёт через TokenCounter, а не эвристику**

1. ContextManager с инжектированным TokenCounter
2. Добавить сообщение с известным количеством токенов
3. Expect: `estimateTokens` возвращает значение TokenCounter, а не `length/2`

- [ ] **Step 2: Инжекция TokenCounter**

`token-counter.ts` — экспортировать переиспользуемый инстанс/класс; `bootstrap.ts` — создать один общий для provider и contextManager; `manager.ts` — принимать опциональный `TokenCounter` в конструктор (fallback на эвристику, если не передан).

- [ ] **Step 3: Смягчить компакцию**

`manager.ts` — `KEEP_LAST_N` из конфига (дефолт поднять до ~10-12), интервал компакции из конфига; при компакции сохранять summary с планом и ключевыми решениями (защита от потери контекста задачи).

- [ ] **Step 4: Тесты + typecheck**

Run: `bun test tests/modules/context/manager.test.ts`; `bun test`; `tsc --noEmit` → 0 ошибок.

- [ ] **Step 5: Commit**

```bash
git add src/llm/token-counter.ts src/modules/context/manager.ts src/core/bootstrap.ts tests/modules/context/manager.test.ts
git commit -m "fix: real token counting in ContextManager, gentler compaction"
```

---

## Task 6: Регрессионная проверка MMA на реальном сценарии

**Файлы:**
- Test: ручной прогон в `_testing/plan-verify-case/`

- [ ] **Step 1: Прогнать тесты и typecheck**

Run: `bun test` (ожидаем все pass) и `tsc --noEmit` (0 ошибок).

- [ ] **Step 2: Прогнать сценарий, который упал**

```
bun run mma "<лендинг-задача, как в сессии>" --no-agents-md --exit-on-complete -d _testing/plan-verify-case/
```

Ожидаем:
- [ ] read_file при чтении большого файла возвращает чанк с указанием offset, карточка тула показывает полный путь
- [ ] после plan тула следующий system-промпт содержит чеклист
- [ ] финальный ответ не приходит, пока план не выполнен (или возвращается предупреждение о pending шагах)
- [ ] перед завершением запущена проектная проверка (`tsc --noEmit`/`npm run build`), ошибки попали в вывод модели
- [ ] отображаемый используемый контекст соответствует реальному подсчёту js-tiktoken

- [ ] **Step 3: Записать результаты в `docs/testing/observations.md`**

Добавить запись OBS-005 «Plan/verify/context regressions from ses_msa53vs8_4elcpu» со статусом fixed/remaining.

- [ ] **Step 4: Обновить AGENTS.md**

Отметить Plan 10 как выполненный; добавить в раздел Execution Guarantees пункты: финальный аудит перед завершением, плановая проверка проекта, чанкинг read-file, реальный подсчёт токенов.

---

## Success Criteria

1. `bun test` — все тесты проходят; `tsc --noEmit` — 0 ошибок.
2. Повторный прогон сценария из сессии не перезапускает план с начала, не «завершает» до верификации и не выдаёт нерабочий проект.
3. Пользователь видит в карточке read_file полный путь и формат; контекст отображается реальными токенами.
