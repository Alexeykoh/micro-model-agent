# Session Auto-Naming & Counter-Agent (Critic) — Design

> **Дата:** 2026-09-25
> **Статус:** approved (design)
> **Ветка:** `feat/session-autoname-and-critic`
> **Тип релиза:** MINOR (новое поведение, новый модуль, новые ключи конфига; без ломающих изменений)
> **Источник задачи:** `TODO.md` → `### P4 — бэклог`

## 1. Контекст и проблема

Два пункта бэклога P4:

1. **Автоназвание сессии.** Сейчас имя сессии либо дефолтное (`session.default_name` → `Session {date}`),
   либо задаётся вручную (`/rename`, `/new <name>`, web `POST /api/sessions {name?}`). Осмысленное имя
   заметно улучшает навигацию в `session list`, `session show`, вкладках `mma web`, `/export`.
2. **Контр-агент.** LLM-роли «критик/ревью» в харнессе **нет**. Есть только детерминированные
   верификаторы (`StepVerifier`, `Auditor`, `AuditGate`), MoE-верификатор
   (`OrchestratorClient.verifyAndMerge`) и лёгкий `LLMJudge`. `docs/literature.md` фиксирует это как
   gap #9 («No inferential sensors — AI code review») и «Critical #2 — No Evaluator agent».

Позиционирование MMA — универсальный агент-харнесс для маленьких моделей (32K–64K). Дизайн обоих
механизмов обязан: не раздувать контекст, не добавлять шума на тривиальных задачах, не блокировать
первый ход, деградировать безопасно (fail-open) и быть наблюдаемым в `session.jsonl`.

## 2. Цели и не-цели

**Цели**

- Осмысленное имя сессии, появляющееся сразу и автоматически, с уточнением LLM-заголовком.
- Одноразовость: авто-имя никогда не затирает ручное.
- Indep-loop критик, проверяющий работу по **внешним свидетельствам** (файлы, команды, тесты),
  а не «по размышлению».
- Мягкая обратная связь с ограниченной эскалацией; не бесконечные циклы, не ложные блокировки.

**Не-цели**

- Не заменять `AuditGate`/`HallucinationGate`/`StepVerifier` — критик дополняет их.
- Не менять MoE-путь (`verifyAndMerge` остаётся как есть; критик там выключен).
- Не делать авто-переименование периодическим/адаптивным (решено: один раз).
- Не вводить обязательную отдельную модель для критика (опциональный override).

## 3. Часть 1 — Автоназвание сессии

### 3.1 Модель данных

`SessionMeta` (`src/modules/session/types.ts`) получает поле:

```ts
nameSource?: "default" | "auto" | "manual";
```

Обратная совместимость: отсутствие поля трактуется как `"default"`; старые `meta.json` читаются без
миграции. Поле пишется в тот же `meta.json` (`SessionStore.saveMeta`, `src/modules/session/store.ts`).

- `SessionManager.create(name?)` — если `name` передан явно → `nameSource: "manual"`; иначе `"default"`.
- `SessionManager.rename(id, name, source: "auto" | "manual" = "manual")` — расширяется опциональным
  источником; существующие вызовы (`/rename`) остаются `"manual"` по умолчанию.
- Авто-логика (см. 3.3) применяется только когда текущий `nameSource` ∈ `{"default", "auto"}`.

### 3.2 Триггер

Единая кросс-транспортная точка — `Agent.run()` (`src/core/agent.ts:501-590`). Сразу после гарантии
активной сессии (создание при отсутствии) фиксируется `isFirstMessage = activeMeta.messageCount === 0`
(meta инкрементится в `SessionStore.appendMessage`), затем — после `contextManager.addMessage(...)` и
`slog.logUser(input)` — запускается авто-имя. Порядок важен: `messageCount` уже стал `1`, поэтому
признак первого сообщения читается до записи.

Один и тот же код обслуживает REPL, one-shot (`mma "<prompt>"`) и web (`POST /api/message`), т.к. все
идут через `Agent.run`.

### 3.3 Поток (гибрид; не блокирует ход)

```
Agent.run(input)
  └─ if session.messageCount === 0 && nameSource ∈ {default, auto}:
       1) name = deriveSessionName(input)          // синхронно, мгновенно
          rename(id, name, "auto")                  // fail-safe
       2) if config.session.autoName !== false:    // fire-and-forget, НЕ await
          void generateSessionTitle(input)
            .then(t => t && nameSource === "auto" && rename(id, t, "auto"))
            .catch(() => {})                        // fail-open
```

1. **`deriveSessionName(input)`** (чистая функция, `src/modules/session/auto-name.ts`):
   - взять первую непустую строку;
   - убрать markdown-обёртку (```), заголовочные `#`, маркеры списка, URL, inline-code;
   - схлопнуть пробелы, срезать завершающую пунктуацию;
   - cap ~60 символов по границе слова (без обрыва посреди слова); если ничего не осталось
     (image-only / пустой ввод) → `t("session.default_name", { date })`.
2. **`generateSessionTitle(input)`** — LLM-роль `SessionNamer` (лёгкий вызов, шаблон
   `collectText` из `src/core/prompt-overflow.ts`, активный провайдер, `reasoningEffort: "none"`,
   `max_tokens ≈ 24`, timeout ~8s). Промпт: «Дай короткий заголовок сессии, 3–6 слов, на языке
   пользователя; без кавычек, эмодзи и завершающей пунктуации». Вход — только первое сообщение
   пользователя (дёшево, без истории).
   - Успех и `nameSource === "auto"` (ручной `/rename` за время вызова не случился) → `rename(id, title, "auto")`.
   - Любая ошибка/таймаут/пустой результат → сохраняется детерминированное имя.

Имя пишется **в сессию**, не в stdout/чат; `--json`-контракт не меняется.

### 3.4 Конфиг

`SessionConfig` (`src/config/types.ts:143-147`) расширяется:

```ts
session: {
  autoSave: boolean;
  maxSessions: number;
  isolateMemory: boolean;
  autoName: boolean;        // default: true
}
```

Дефолт — в `src/config/defaults.ts` (`session` блок). `false` полностью отключает LLM-уточнение
(детерминированное имя остаётся). Отдельной модели нет — используется активная.

### 3.5 Поверхности

- `session list`/`show`, `/export`, `/sessions` читают `meta.name` → обновление бесплатно.
- `mma web`: `HostStateSnapshot.sessionName` (`src/core/host.ts:14`, заполняется в
  `src/modules/webui/module.ts:141-146`) + SSE-событие с именем (в `state`/`turn_end`) → `app.js`
  обновляет вкладку и дропдаун (`src/modules/webui/assets/app.js:979-1106`). Fallback — обновление из
  периодического `GET /api/sessions`.
- `/status` и session prompt-блок (`src/modules/session/module.ts`) подхватывают имя при следующей сборке.

### 3.6 Крайние случаи

- Сессия без сообщений (не было `run`) — не именуется.
- Авто-имя применяется только к уже существующей активной сессии и само её не создаёт — триггер
  стоит после гарантии сессии в `Agent.run`.
- Несколько ходов до применения LLM-заголовка (медленный провайдер / abort) — обработчик проверяет
  `nameSource === "auto"` и актуальность сессии.
- `Esc`/abort первого хода не должен оставлять «полу-имя» — фон не awaited, ошибки глушатся.

## 4. Часть 2 — Контр-агент (in-loop critic)

### 4.1 Принцип

Критик — **tool-interactive / evidence-grounded**, а не чистый self-review. Литература однозначна:
интринсик self-correction без внешнего сигнала ненадёжна и может ухудшать результат
(Huang 2024; CRITIC, ICLR 2024; Kamoi 2024). Поэтому вход критика — детерминированный **evidence pack**
с фактами о ходе, а не только финальный текст. Опционально — ограниченный read-only tool-loop для
перепроверки конкретного утверждения (Agent-as-a-Judge).

### 4.2 Компоненты

**Новый модуль `src/modules/critic/`:**

- `types.ts`
  ```ts
  type CriticSeverity = "info" | "concern" | "critical";
  interface CriticIssue { severity; claim; problem; suggestion?; evidence? }
  interface CriticVerdict { status: "ok" | "concern" | "critical"; summary: string; issues: CriticIssue[] }
  ```
- `evidence.ts` — `buildEvidencePack(state): EvidencePack`, компактно и бюджетно:
  - исходная задача / последний user-запрос;
  - план и статусы шагов (`PlanStore`);
  - изменённые/созданные/удалённые файлы;
  - выполненные команды + exit code, результаты тестов/typecheck;
  - tool-output-диджест (существующие `summarizeToolArgs` из `src/core/agent/tool-output.ts`,
    `extractFileLikeTokens` из `src/modules/hallucination/js-identifiers.ts`).
- `client.ts` — `class CriticClient` по образцу `OrchestratorClient`
  (`src/llm/orchestrator.ts`): построение провайдера (`buildManagedProvider`-паттерн) → активная
  модель по умолчанию, либо `critic.provider`/`critic.model`; `verify(pack, signal): Promise<CriticVerdict>`;
  строгий JSON + `jsonrepair` (как `parseJSON`). Промпт-правила: флагать **только проверяемое по
  свидетельствам**; не выдумывать; неуверенность → максимум `concern`; «лучше тишина, чем шум»;
  не придираться к стилю.
- `tools.ts` (опц., при `critic.tools === true`) — ограниченный read-only tool-loop
  (`read_file`/`grep`/`glob`/`file_info`/`list_dir`), максимум ~3 вызова, чтобы проверить конкретное
  утверждение; при отсутствии tool-capability у модели — только evidence pack.

**`src/core/agent/critic-gate.ts`** — `class CriticGate` (зеркало `AuditGate`,
`src/core/agent/audit-gate.ts`), владеет решением «когда/что делать».

### 4.3 Авто-гейтинг и триггеры

Критик **не вызывается** на тривиальных/read-only/чат-ходах (аналог P5 tool-narrowing по духу).
Ход является кандидатом только если был ≥1 мутирующий тул (`write_file`/`edit_file`/`delete_file`/
`move_file`/`create_dir`) либо `bash`, который, по существующим сигналам `execution-plugin`
(`onAfterTool`), изменил файлы.

События-триггеры:

- (a) завершён шаг плана;
- (b) накопилось ≥ `mutationsBeforeCheck` мутаций с прошлой проверки (внутренний default 3);
- (c) агент собирается завершить ход после мутаций (перед финальным OUTPUT).

Каденс-константы — внутренние дефолты (не раздуваем конфиг). Дополнительно критик может
переиспользоваться при stuck-эскалации.

### 4.4 Права и эскалация

- `ok` → ничего.
- `concern` → одна ограниченная `<system-summary>` с findings (по строке на issue), dedupe по
  сигнатуре проблемы, чтобы не зацикливаться.
- `critical` → **один bounded repair-цикл** (`critic.maxRepairCycles`, default 1); после него ход
  завершается даже с неразрешённым — с честным предупреждением пользователю.
- **Fail-open** на ошибке/таймауте/непарсимом JSON/отсутствии провайдера: критик молчит.

### 4.5 Защита от петель и взаимодействие с гейтами

- Глобальный cap `critic.maxCalls` на ход (default 4) + dedupe issues + не перепроверять неизменное
  состояние (хэш evidence pack / позиция трейсa).
- Порядок: если `AuditGate` уже блокирует завершение — критик не вызывается. `HallucinationGate`
  сохраняет свою роль; критик не дублирует проверку путей (это `FactualCheck`).
- В MoE-пути критик **выключен** (`runWithMoE` уже вызывает `verifyAndMerge`).

### 4.6 Конфиг

Домен `critic` (defaults в `src/config/defaults.ts`):

```ts
critic: {
  enabled: boolean;          // true
  provider?: string;         // override активного провайдера
  model?: string;            // override активной модели
  tools: boolean;            // true — разрешить read-only tool-loop
  maxCalls: number;          // 4 на ход
  maxRepairCycles: number;   // 1
  timeoutMs: number;         // 15000
}
```

### 4.7 Наблюдаемость и UI (STYLE.md)

- `SessionLogger.logCritic` (`src/core/session-logger.ts`) → события `critic_check` / `critic_verdict` /
  `critic_escalation` в `session.jsonl`, видны в `session show`.
- Чат quiet по умолчанию: одна строка `⟡ проверка · N замечаний` только при `concern`/`critical`;
  подробности — по `/verbose`. Глифы/цвета по `docs/design/ui/STYLE.md`, без boxed-панелей.
- i18n: `critic.*` (en+ru), включая предупреждение при неразрешённом критическом issue.

## 5. Литература и обоснование решений

| # | Источник | Год | Вывод для дизайна |
|---|----------|-----|-------------------|
| 1 | Shinn et al., *Reflexion* (NeurIPS) | 2023 | Вербальная рефлексия в episodic buffer помогает агентам; критик — in-loop, не только финал. |
| 2 | Madaan et al., *Self-Refine* (NeurIPS) | 2023 | Итеративная feedback+refine одной моделью; но требует качественного фидбэка. |
| 3 | Gou et al., *CRITIC* (ICLR) | 2024 | **Ключевой:** чистая self-correction ненадёжна; сила — во внешней инструментальной проверке. → evidence pack + read-only тулы. |
| 4 | Huang et al., *LLMs Cannot Self-Correct Reasoning Yet* (ICLR) | 2024 | Интринсик self-correction может ухудшать; нельзя эскалировать вслепую. → fail-open, bounded cycles, separate model опц. |
| 5 | Kamoi et al., *When Can LLMs Actually Correct Their Own Mistakes?* (TACL) | 2024 | Успех только при надёжном внешнем фидбэке; избегать de-generation. → cap циклов, dedupe. |
| 6 | Dhuliawala et al., *Chain-of-Verification (CoVe)* | 2023 | Планируемые проверочные вопросы снижают галлюцинации. → критические проверки формулируются как вопросы к свидетельствам. |
| 7 | Zheng et al., *LLM-as-a-Judge* (MT-Bench/Chatbot Arena) | 2023 | LLM-судья масштабируем, но подвержен bias; нужна строгая рубрика. → JSON-вердикт + фиксированные правила. |
| 8 | Zhuge et al., *Agent-as-a-Judge* (ICML) | 2025 | Агентная оценка с промежуточным фидбэком точнее LLM-as-a-Judge. → in-loop проверка + read-only доступ к артефактам. |
| 9 | Lightman et al., *Let's Verify Step by Step* | 2023 | Process supervision > outcome-only. → пошаговые/событийные триггеры, а не только финальная оценка. |
| 10 | McAleese et al., *CriticGPT / LLM Critics Help Catch LLM Bugs* | 2024 | Отдельный обученный критик повышает recall поиска ошибок. → опциональный отдельный провайдер/модель. |
| 11 | Pan et al., *Automatically Correcting LLMs: Survey* | 2024 | Таксономия self-correction; внешний фидбэк и model-debate — основные рабочие ветки. |
| 12 | Weng et al., *LLMs are Better Reasoners with Self-Verification* | 2023 | Обратная проверка (backward verification) улучшает корректность. |
| 13 | NVIDIA, *Small Language Models are the Future of Agentic AI* | 2025 | Для малых моделей важны компактный контекст и внешние сигналы. → компактный evidence pack, жёсткий бюджет. |
| 14 | `docs/literature.md` [5] Böckeler/Martin Fowler | 2026 | Computational vs Inferential sensors. → закрываем отсутствие inferential sensor. |

**Итоговые принципы дизайна:** (1) критика опирается на внешние свидетельства; (2) промежуточный,
событийный фидбэк; (3) ограниченные циклы и dedupe против дегенерации; (4) отдельная модель —
опция, не требование; (5) fail-open и тишина вместо шума.

## 6. Тестирование

- **`deriveSessionName`** (unit): пустой ввод, markdown/URL/code, длинный текст (граница слова),
  image-only → fallback, юникод.
- **Gate-матрица имён**: `default`→auto, `auto`→auto, `manual`→no-op, `autoName:false`→только детерминированное.
- **Fail-open имён**: провайдер бросает/таймаутит → остаётся детерминированное; abort не ломает.
- **Web-refresh**: имя доезжает в `HostStateSnapshot`/SSE (asset-level тест).
- **Critic gate** (unit): тривиальный ход → skip; мутация → run; `maxCalls` cap; dedupe; escalation
  укладывается в `maxRepairCycles`; `AuditGate`-block → критик не вызывается.
- **Critic client** (unit): парсинг `ok/concern/critical`, битый JSON → fail-open; timeout → fail-open;
  evidence pack строится из моков состояния.
- **Интеграция** — через test seams (`AgentDeps.criticOverride`, `criticClientOverride`), без
  `vi.mock` (в Bun мок глобален на процесс — запрет задокументирован).
- Прогон: `bun test`, `tsc --noEmit`, `bun run lint`, `bun run quality`.

## 7. Затрагиваемые файлы (план)

**Новые**

- `src/modules/session/auto-name.ts` (`deriveSessionName`, `generateSessionTitle`)
- `src/modules/critic/{types,evidence,client,tools}.ts`
- `src/core/agent/critic-gate.ts`
- `tests/` — unit + integration (по §6)

**Изменяемые**

- `src/modules/session/types.ts` (`nameSource`), `manager.ts` (`create`/`rename` source),
  `store.ts` (персист `nameSource`)
- `src/core/agent.ts` (хук авто-имени в `run`; `CriticGate` в `executeSingleAgentLoop`; `AgentDeps`
  test seams)
- `src/config/{types,defaults}.ts` (`session.autoName`, домен `critic`)
- `src/core/session-logger.ts` (`logCritic`)
- `src/core/host.ts`, `src/modules/webui/{module.ts,assets/app.js}` (имя в снапшоте/SSE)
- `src/i18n/{en,ru}.json` (`session.*`, `critic.*`)
- `docs/agents/architecture.md` (или `modules.md`), `docs/literature.md` (gap #9 / «No Evaluator agent»
  → moved to plan), `CHANGELOG.md`, `TODO.md` (P4 → done), `AGENTS.md` (краткий раздел о фичах)

## 8. Совместимость и миграция

- `nameSource` опционален → старые сессии читаются без миграции.
- `session.autoName` и `critic.*` имеют дефолты → старые конфиги валидны.
- `--json`-контракт не меняется (имя — в сессии; критик — события в `session.jsonl`).
- MoE-путь и существующие гейты не меняют поведение.

## 9. Открытые вопросы

Нет — все развилки закрыты в брейншторме:

| Вопрос | Решение |
|--------|---------|
| Метод авто-имени | Гибрид: детерминированное сразу + LLM-дозаголовок |
| Частота/перезапись | Одноразово; ручной `/rename` неприкосновенен |
| Дефолт авто-имени | Вкл + конфиг `session.autoName` |
| Роль критика | Непрерывный критик в петле |
| Каденс | По событиям (subtask / N мутаций / перед завершением) |
| Права критика | Совет + эскалация до bounded-блока |
| Модель критика | Активная по умолчанию, отдельная опционально |
| Дефолт критика | Вкл с авто-гейтингом |
| Интеграция | `CriticGate` + модуль `critic` |

## 10. Следующий шаг

После ревью этой спеки — `writing-plans`: детальный план в `docs/superpowers/plans/` (атомарные шаги,
`bun test` + `tsc --noEmit` перед каждым коммитом).
