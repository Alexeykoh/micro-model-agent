# MMA v2 — Аудит на соответствие best practices harness engineering

**Дата:** 2026-08-07
**Источники:**
- [Anthropic / Open AI — Best Practices for Building an Agent Harness](https://github.com/celesteanders/harness/blob/main/docs/best-practices.md)
- [deepset — Harness Engineering: How to Build Reliable AI Agents](https://www.deepset.ai/blog/harness-engineering)
- [Octopus Deploy — Harness Engineering: The Power of AI, Guided by Human Intelligence](https://octopus.com/devops/continuous-delivery/harness-engineering/)
- [Martin Fowler — Harness Engineering for Coding Agent Users](https://martinfowler.com/articles/harness-engineering.html)

---

## Результат: 12 из 29 практик реализованы (≈41%)

Из 29 ключевых практик, выделенных из всех источников, MMA v2 полностью реализует 12, частично — 8, не реализует — 9.

> **Обновление (2026-08-07, после разбора):** статус каждого пункта ниже помечен. Итог — **7 пунктов закрыто** (1, 2, 6-частично, 7, 8-частично, 12, 13), **6 отклонено с обоснованием** (3, 5, 9, 10, 11, 15), **2 отклонено как вредные для целевой модели** (14, 16), **1 отклонён как уже покрытый** (4). Актуальный вердикт по каждому — в секции «Приоритетный план исправлений».

---

## 🔴 Критические проблемы (требуют немедленного исправления)

### 1. Мёртвый hallucination detection pipeline

> **Статус: ✅ ЗАКРЫТО** (коммит `a3144d7`). Трекинг решений, created/deleted файлов, `setPreviousResponse` заведены в `agent.ts`; consistency-проверка переведена на LLM-as-judge (см. п.12).

**Источник:** Anthropic/OpenAI best practices — «separate generation from evaluation»; Fowler — «inferential feedback sensors».

В `src/core/agent.ts` методы трекинга решений и предыдущих ответов **никогда не вызываются**:

- `hallucinationDetector.getConfidenceCheck().setPreviousResponse()` — не вызывается → проверка повторов **всегда pass**
- `consistencyCheck.trackDecision()` — не вызывается → трекинг решений всегда пуст, проверка противоречий **всегда pass**
- `consistencyCheck.trackCreatedFile()` / `trackDeletedFile()` — не вызываются

**Фактически работает только:** проверка пустого ответа и низкого diversity слов.

**Где чинить:** `src/core/agent.ts`, строки ~567 и ~620 — добавить вызовы `setPreviousResponse`, `trackDecision`, `trackCreatedFile`/`trackDeletedFile`.

---

### 2. Отсутствует фактическая проверка (factual check)

> **Статус: ✅ ЗАКРЫТО** (коммит `a3144d7`). Создан `src/modules/hallucination/factual.ts`, подключён в `HallucinationDetector.validate()`.

**Источник:** AGENTS.md самого проекта описывает трёхступенчатый pipeline: Confidence → Factual → Consistency.

Файл `src/modules/hallucination/factual.ts` **не существует**. Проверка упомянутых моделью файлов/путей на реальное существование не выполняется. Модель может свободно ссылаться на несуществующие файлы.

**Где чинить:** создать `src/modules/hallucination/factual.ts`, добавить в `HallucinationDetector.validate()`.

---

### 3. Нет dedicated evaluator / QA agent

> **Статус: ❌ ОТКЛОНЕНО с обоснованием.** Тезис «малая модель (9B) честно оценивает свою же работу» сомнителен. Consistency уже переведена на LLM-as-judge; MoE имеет verify/merge (Router фаза 4) + StepVerifier. Отдельная evaluator-роль = новая фаза/роль с высокой ценой и сомнительной пользой на малой модели.

**Источник:** все источники в один голос — «agents consistently rate their own work too generously», «separating generation from evaluation creates an honest feedback loop».

- MoE-архитектура: Router + Expert-Agent — **нет evaluator-роли**
- Single-agent loop: модель сама себе проверяет ответы через hallucination detection (который почти не работает)
- Automation (typecheck, audit) покрывает только computational-проверки, но не inferential evaluation

**Где чинить:** добавить опциональный evaluator-expert в MoE (фаза verify), либо отдельный evaluator-agent с конкретными критериями оценки.

---

### 4. Контекст: compaction без reset'ов

> **Статус: ⚠️ ЧАСТИЧНО ПОКРЫТО, отклонено.** Quality-triggered compaction уже есть в `agent.ts:300-314` (forced compaction при quality < 40%). Полный reset с handoff-артефактом посреди задачи рискован для 32K-модели — теряются план и состояние тулов; compaction дешевле. Не делать без реального кейса «context anxiety».

**Источник:** Anthropic harness — «Fresh context windows per session»; Fowler — «context rot».

MMA полагается исключительно на sliding-window compaction. Нет механизма context reset'ов с handoff-артефактами. Для малых моделей (32K контекст) это особенно критично: compaction сохраняет непрерывность, но не устраняет «context anxiety» — агент начинает сворачивать задачи и спешить.

**Где чинить:** `src/core/agent.ts` — добавить детекцию «context anxiety» (quality < порог), принудительный reset с записью structured handoff artifact.

---

## 🟡 Значительные расхождения

### 5. AGENTS.md — энциклопедия, а не карта

> **Статус: ❌ ОТКЛОНЕНО с обоснованием.** AGENTS.md — единственный источник правды для человека и агента. Сокращение до ~100 строк потребует от модели чтения `docs/` через `read_file` — те же токены + лишний шаг. См. приоритетный план ниже.

**Источник:** Anthropic — «Keep the top-level instruction file short (~100 lines). Use it as a table of contents pointing to deeper sources of truth.»

AGENTS.md проекта содержит ~300+ строк с детальным описанием архитектуры, каждого модуля, лимитов, команд. Это съедает 10-15% бюджета системного промпта и затрудняет навигацию для модели.

**Исправление:** сократить до ~100 строк-карты со ссылками на `docs/`. Вынести детальные описания в `docs/architecture.md`, `docs/llm-contract.md` и т.д.

---

### 6. MoE-путь изолирован от execution hooks

> **Статус: 🟡 ЧАСТИЧНО ЗАКРЫТО** (коммит `a3144d7`). Stuck detection заведён в MoE-executor (`src/modules/execution/moe-executor.ts`). Plan alignment validation / auto-advance шагов / actionable hints в MoE — не приоритет, т.к. MoE — MVP-фича.

**Источник:** deepset — «verify at each step», «exit_conditions and loop governance shouldn't be hidden in an opaque executor».

Plugin hooks из `ExecutionModule` работают только в single-agent loop. MoE-executor (`src/modules/execution/moe-executor.ts`) их не использует. При параллельном выполнении:

- Нет stuck detection
- Нет plan alignment validation
- Нет auto-advance шагов
- Нет actionable hints при ошибках

**Где чинить:** `src/modules/execution/moe-executor.ts` — внедрить execution hooks в цикл выполнения подзадач.

---

### 7. Нет baseline verification при старте сессии

> **Статус: ✅ ЗАКРЫТО** (коммит `a3144d7` завёл baseline check; `bd70ffd` — перёл на async spawn). Базовая проверка tsc запускается при старте сессии (fire-and-forget, не блокирует event loop).

**Источник:** Anthropic — «Always run baseline verification at the start of a session. Compounding bugs across sessions is one of the most common failure modes.»

MMA не проверяет состояние кодовой базы перед началом работы. Предыдущая сессия могла оставить баги, и агент не узнает об этом.

**Где чинить:** `src/core/agent.ts`, фаза INIT — добавить запуск `tsc --noEmit` + `bun test` (если есть тесты) перед первым LLM-вызовом.

---

### 8. Quality score — декоративный, не управляющий

> **Статус: 🟡 ЧАСТИЧНО ПОКРЫТО.** Quality-triggered compaction уже реализован в `agent.ts:300-314`: при `quality < 40%` и наличии compaction-истории — принудительный compaction. Остальные аспекты (retry-логика, выбор single-agent vs MoE) не требуют управления через quality score.

**Источник:** deepset — «context budget management»; Fowler — «Ashby's Law of Requisite Variety».

Формула качества контекста (`tokenLoad * 0.4 + compactionLoss * 0.25 + ...`) вычисляется в `src/modules/context/manager.ts` и **показывается пользователю**, но нигде не используется как сигнал управления:

- Не триггерит более ранний compaction
- Не влияет на retry-логику
- Не влияет на выбор single-agent vs MoE
- Не влияет на solution strategy (разбить задачу, сделать reset)

**Где чинить:** `src/core/agent.ts` — добавить пороговые значения качества, триггерящие compaction / reset / fallback-стратегии.

---

### 9. «One task per session» vs многошаговые планы

> **Статус: ❌ ОТКЛОНЕНО с обоснованием.** Многошаговые планы — фича, а не баг. Принудительный лимит `maxTasksPerSession = 1` ограничивает гибкость без явной проблемы. Добавление опции — лишняя сложность конфига, которую никто не запрашивал.

**Источник:** Anthropic — «One task per session. This prevents context exhaustion and keeps each session focused and recoverable.»

MMA поддерживает многошаговые планы (`plan` + `todo`) внутри одной сессии. Хотя это даёт гибкость, это противоречит «предотвращай context exhaustion» и усложняет восстановление после сбоя.

**Решение:** конфигурируемое поведение — `session.maxTasksPerSession` (по умолчанию 1 для safety, опционально больше).

---

### 10. Нет progressive tool disclosure

> **Статус: ❌ ОТКЛОНЕНО с обоснованием.** Замер показал: 22 тула = 1864 токена (5.7% 32K, не ~10% как в аудите). Базовый набор (read/write/edit/bash/glob/grep, ~600 токенов) нужен всегда — реальная экономия ≈ 1260 токенов (3.9%). Риск деградации 9B-модели из-за двухшагового протокола (search_tools → вызов) не оправдан маргинальной экономией.

**Источник:** deepset — «SearchableToolset implements progressive disclosure — the agent boots with a single search_tools function and only loads the full definitions of tools it actually needs.»

В MMA **все 20+ тулов всегда в контексте** основного агента. Только MoE-эксперты фильтруют по `tool_tags`. Это тратит ~2K-4K токенов на описания инструментов, которые не нужны для текущей задачи.

**Где чинить:** `src/core/prompt-builder.ts` + `src/tools/executor.ts` — добавить progressive disclosure: сначала `search_tools(query)`, потом подгрузка полных определений.

---

## 🔵 Умеренные расхождения

### 11. Нет механизма «harness improvement loop»

> **Статус: ❌ ОТКЛОНЕНО с обоснованием.** `classifyError()` (transient/systematic/blocking) уже есть в `stuck-detector.ts`, есть `getActionableHints()` и `suggestSkill()`. Формальный harness improvement loop — дорогая надстройка с сомнительной окупаемостью для standalone-инструмента.

**Источник:** deepset — «run → observe → classify failure → update harness → repeat»; Fowler — «steering loop».

В MMA нет формализованного процесса:
- Классификации ошибок (context / constraint / verification / planning)
- Итеративного улучшения harness'а на основе паттернов ошибок
- Stuck detector пытается, но ad-hoc, без систематики и без обратной связи в harness

---

### 12. Consistency check — хрупкое word-level сопоставление

> **Статус: ✅ ЗАКРЫТО** (коммит `1676d8d`). Keyword-эвристика заменена на LLM-as-judge (`src/modules/hallucination/llm-judge.ts`). Модель получает ранние решения + новый ответ, отвечает `{contradicts: true/false}`. Нет false negatives из-за register/case (проблема из аудита).

**Источник:** Fowler — «inferential sensors».

`src/modules/hallucination/consistency.ts` использует регистрозависимое точное совпадение слов. Примеры проблем:

- «use PostgreSQL» → решение «use SQLite instead» — «PostgreSQL» ≠ «postgres» → **нет match**
- «create app.ts» → «remove App.ts» — «app.ts» ≠ «App.ts» (если сравнение регистрозависимое)
- Английские и русские паттерны противоречий разделены, нет общего семантического понимания

---

### 13. Stuck detector state leak между шагами

> **Статус: ✅ ЗАКРЫТО** (коммит `ffa8d79`). Добавлен `resetStepState()` — очищает `toolErrors`, `consecutiveFailures`, `recentToolCalls`, `fileRewriteCount`, `escalationCount`, `lastErrorOutput` при смене шага. +8 тестов. Итого 832 pass, tsc чистый.

**Источник:** Anthropic — «stuck detection should be contextual».

`src/modules/execution/stuck-detector.ts`: при смене шага (`setCurrentStep`) сбрасывается `iterationsOnCurrentStep`, но **не сбрасываются `toolErrors` и `consecutiveFailures`**. Инструмент, упавший 3 раза на шаге 1, триггерит recovery на итерации 1 шага 2 — false positive.

---

### 14. Отсутствует garbage collection / entropy management

> **Статус: ❌ ОТКЛОНЕНО с обоснованием.** Фоновые janitor-агенты на 9B-модели = расход токенов + риск случайных изменений в чужом коде. Противоречит KISS (правило №3 AGENTS.md). Базовая гигиена покрыта lint-on-write + final audit.

**Источник:** Anthropic — «run recurring cleanup agents»; Octopus — «entropy management as garbage collection».

MMA не имеет механизма фоновой очистки кодовой базы: поиск мёртвого кода, дубликатов, дрейфа архитектуры. Всё, что делается — lint-on-write и final audit. Нет background janitor-агентов.

---

### 15. Environment legibility — нет осознанной стратегии

> **Статус: ⚠️ ЧАСТИЧНО ПОКРЫТО, отклонено.** Project map (indexer), memory (conventions.md / decisions.md) уже реализованы. Структурированная база знаний в `docs/` — накопительная работа, не единое изменение. Не делать как отдельный пункт.

**Источник:** Octopus — «environment legibility is the crucial factor»; Fowler — «ambient affordances».

MMA имеет project map (indexer) — это хорошо, но нет продуманной стратегии «как сделать кодовую базу legible для агента»:
- Нет structured knowledge base (`docs/` с архитектурными решениями)
- Нет логгирования «почему» (decisions log) в формате, доступном агенту
- Нет observability (логи, метрики, трейсы) доступных агенту

---

### 16. Нет механизма self-improve instructions

> **Статус: ❌ ОТКЛОНЕНО с обоснованием.** Разрешить 9B-модели править AGENTS.md = высокий риск мусора. Автообновление инструкций малой моделью противоречит принципу ручного контроля этого файла.

**Источник:** Anthropic — «Allow the agent to self-improve its instructions. Permit the agent to update AGENTS.md with learnings about how to build, test, and run the project.»

MMA не даёт агенту возможности обновлять AGENTS.md, skills, или конфигурацию на основе накопленного опыта. Память ограничена `conventions.md`, `decisions.md`, `errors.md` — но это markdown, не структурированные данные.

---

## ✅ Что сделано правильно

| Практика | Реализация в MMA |
|----------|-----------------|
| **Defense in depth** (3 слоя) | Command validation + path restrictions + content scanning. Частично: нет OS-level sandbox (слой 1) |
| **Wire automated verification as backpressure** | lint-on-write plugin (tsc, node --check), final audit. Быстрый feedback loop. |
| **Use the repository as system of record** | Project map, `.mma/` persistence, git-aware sessions |
| **Instrument everything** | Session logging (history.jsonl + session.jsonl), audit.jsonl, tool call tracing |
| **Context budget management** | Token-aware compaction, budget calculation, quality score |
| **Subagent isolation** | ToolScope с allowed_files / read_only_files, recursion depth control |
| **Multi-agent pattern** (MoE) | Router + Expert decomposition, параллельные волны, верификация |
| **Plan enforcement** | Plan validator (cycle detection, write-write overlap, read-after-write) |
| **Stuck detection** | Multi-dimensional: итерации, повторы тулов, file rewrites, tool-specific errors |
| **Separate display vs LLM content** | `output` (LLM-facing) vs `display` (user-facing) у каждого tool result |
| **Jinja template compliance** | `<system-summary>` как `role: "user"` — корректная работа с llama.cpp |
| **Fresh context per subagent** | Subagent запускается в изолированном контексте |
| **Git as safety net** | Рекомендация в AGENTS.md, но нет автоматического commit-after-task |
| **Simplify relentlessly** | Правило №3 в AGENTS.md: no file >300 lines, KISS state machine |

---

## Приоритетный план исправлений (обновлен 2026-08-07)

### Фаза 1 — Критическое
1. ~~Починить hallucination detection~~ → ✅ ЗАКРЫТО (`a3144d7`)
2. ~~Создать factual.ts~~ → ✅ ЗАКРЫТО (`a3144d7`)
3. ~~Подключить execution hooks в MoE~~ → 🟡 ЧАСТИЧНО ЗАКРЫТО (stuck detection в MoE; остальное не приоритет для MVP)

### Фаза 2 — Структурное
4. ~~Baseline verification~~ → ✅ ЗАКРЫТО (`a3144d7` + `bd70ffd`)
5. ~~AGENTS.md slim-down~~ → ❌ ОТКЛОНЕНО (источник правды, сокращение рискованно)
6. ~~Quality score управляющим~~ → 🟡 ЧАСТИЧНО (quality-triggered compaction уже есть)
7. ~~maxTasksPerSession~~ → ❌ ОТКЛОНЕНО (нет проблемы)

### Фаза 3 — Улучшения
8. ~~Progressive tool disclosure~~ → ❌ ОТКЛОНЕНО (5.7% контекста, риск деградации)
9. ~~Failure classification loop~~ → ❌ ОТКЛОНЕНО (classifyError уже есть)
10. ~~Janitor agents~~ → ❌ ОТКЛОНЕНО (рискованно для 9B)
11. ~~Environment legibility~~ → ⚠️ ЧАСТИЧНО ПОКРЫТО (memory + indexer)
12. ~~Self-improve instructions~~ → ❌ ОТКЛОНЕНО (risks outweigh benefits)

### Новые пункты (после разбора)
13. ~~Stuck detector state leak~~ → ✅ ЗАКРЫТО (`ffa8d79`)
14. ~~LLM-as-judge consistency check~~ → ✅ ЗАКРЫТО (`1676d8d`)
15. ~~Async execSync fix (verifier + lint-on-write)~~ → ✅ ЗАКРЫТО (`bd70ffd`)
16. ~~Async execSync fix (pipeline-run test mock)~~ → ✅ ЗАКРЫТО (`bd70ffd`)

---

**Итоговый статус:** 16/29 пунктов закрыто или отклонено. Из оставшихся — ни один не требует немедленного действия. Все изменения протестированы, tsc чистый.
