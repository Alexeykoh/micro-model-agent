# Agent-Level MoE — Hierarchical Recursive Decomposition

## Статус

Draft. Решения из этой версии зафиксированы после обсуждения и готовы к implementation planning.

## Цель

Применить принцип **Mixture of Experts (MoE)** на уровне архитектуры агента, а не на уровне нейросети. Для 9B-моделей с 32K–64K контекстом это даёт:

- Контекст не забивается нерелевантными инструментами и скиллами.
- Каждый эксперт использует весь бюджет контекста под свою задачу.
- Возможность назначать разные модели под разных экспертов.
- Естественный focus window — эксперт видит только свою предметную область.

## Out of scope

- Разное квантование одной и той же модели. Поддержка разных моделей реализуется через `model` в конфиге эксперта; квантование остаётся на стороне провайдера/локального запуска.
- Keyword matching для выбора эксперта. Router — это LLM, который сам выбирает `expert_tag`.
- Scope expansion для subagents. В MVP scope фиксирован; расширение scope — post-MVP feature.

## Архитектура (3 уровня)

```
User
  ↓
[Router] (orchestrator.ts, plan mode)
  ↓
{ shared_context, subtasks[] }
  ↓
for each subtask:
  [Expert-Agent] (subagent + expert tool group + expert model)
    ↓
  [Expert-Tools] (filtered by tool tags)
    ↓
  sub-session + summary + result
  ↓
[Router] (orchestrator.ts, verify/merge mode)
  ↓
final output  или  re-plan (max 3 цикла)
```

### Level 1 — Router

- Получает задачу пользователя.
- Делает один LLM-вызов в режиме `plan`.
- Возвращает JSON:
  - `shared_context` — общие ссылки и правила, чтобы subtasks не были изолированными.
  - `subtasks` — массив subtask с `expert_tag`, `max_tokens`, `allowed_files` (write/delete scope), `read_only_files` (read scope), `input_from` (данные от других subtasks), `expected_artifacts`, `success_criteria`, `depends_on`.
- Перед запуском проверяет, что `allowed_files` subtasks не пересекаются (если пересекаются — reject плана или merge scope).
- После выполнения всех subtasks переключается в режим `verify/merge`:
  - проверяет результаты через `execution/verifier.ts`;
  - проверяет консистентность;
  - делает финальный ответ или запускает re-plan (максимум 3 цикла).

### Level 2 — Expert-Agent

- Запускается как `subagent.ts` с узким промптом.
- Видит только:
  - свой `prompt`;
  - `shared_context`;
  - группу инструментов, разрешённую для `expert_tag`;
  - модель, назначенную для `expert_tag`;
  - `max_tokens` — бюджет для этого subtask (explicit или default от expert_tag).
- Работает внутри `allowed_files` (write/delete) и `read_only_files` (read).
- После выполнения сохраняет:
  - **sub-session** — полный execution log;
  - **summary** — lightweight результат для поиска и merge;
  - **result** — артефакты для передачи Router.

### Level 3 — Expert-Tools

- Инструменты в `tools/registry.ts` помечаются тегами: `code`, `research`, `browser`, `design`, `file`, `shell`, etc.
- Каждый `expert_tag` в конфиге сопоставлен с набором `tool_tags`.
- В runtime система фильтрует `tools/registry.ts` и передаёт subagent только релевантные инструменты.
- Описания инструментов остаются минимальными и точечными.

## Формат плана

```json
{
  "shared_context": {
    "refs": [
      "src/core/agent.ts",
      "src/tools/registry.ts",
      "AGENTS.md"
    ],
    "rules": [
      "Не нарушать правило #10 AGENTS.md: никакого keyword matching.",
      "Все TypeScript-файлы должны проходить tsc --noEmit."
    ]
  },
  "subtasks": [
    {
      "id": "t1",
      "prompt": "Добавь теги в registry.ts для инструментов чтения/записи файлов.",
      "expert_tag": "code",
      "max_tokens": 8000,
      "allowed_files": ["src/tools/registry.ts", "src/tools/types.ts"],
      "read_only_files": ["src/config/defaults.ts"],
      "expected_artifacts": ["src/tools/registry.ts"],
      "success_criteria": [
        "Каждый инструмент имеет поле tags.",
        "Теги code/file/shell/research корректно расставлены."
      ],
      "depends_on": []
    },
    {
      "id": "t2",
      "prompt": "Добавь mapping expert_tag → tool_tags + model в config/defaults.ts.",
      "expert_tag": "code",
      "max_tokens": 8000,
      "allowed_files": ["src/config/defaults.ts", "src/config/types.ts"],
      "read_only_files": ["src/tools/registry.ts", "src/tools/types.ts"],
      "expected_artifacts": ["src/config/defaults.ts"],
      "success_criteria": [
        "В defaults.ts есть раздел experts.",
        "Каждый expert_tag ссылается на tags из registry."
      ],
      "depends_on": ["t1"]
    }
  ]
}
```

## Data flow

1. **Plan** — Router получает задачу и возвращает план.
2. **Validate** — система проверяет:
   - `expert_tag` существует в конфиге;
   - `allowed_files` не пересекаются между subtasks никогда;
   - `read_only_files` не пересекаются с `allowed_files` других subtasks, кроме случаев read-after-write;
   - `depends_on` не образует циклов.
3. **Execute** — subtasks запускаются параллельно, уважая `depends_on`.
4. **Collect** — результаты, summaries и sub-sessions сохраняются.
5. **Verify/Merge** — Router вызывает `execution/verifier.ts`, запускает глобальные verification команды (tsc, bun test) и проверяет консистентность. Верификация выполняется на уровне Router, а не внутри subagent.
6. **Output** — финальный ответ или re-plan.

> **Cross-expert merge:** результаты разных типов экспертов (code diff, research text, browser screenshot, vision JSON) не объединяются через git-merge. Router собирает их в финальный ответ и проверяет end-to-end консистентность.

## Cross-expert result flow

Когда один subtask должен использовать результат другого, Router передаёт его через `shared_context` или через `input_from` поле:

```json
{
  "id": "t5",
  "prompt": "Проанализируй скриншот формы логина и определи селекторы.",
  "expert_tag": "vision",
  "input_from": {
    "screenshot": { "subtask_id": "t4", "field": "result.screenshot_base64" }
  }
}
```

Альтернативно Router может включить результат предыдущего subtask в `shared_context.refs` как `t4-result`, но `input_from` предпочтительнее, потому что явно указывает зависимость по данным.

## Expert registry

### tags в tools/registry.ts

Пример:

```typescript
export const tools: ToolDefinition[] = [
  {
    name: "read_file",
    tags: ["file", "code"],
    // ...
  },
  {
    name: "web_search",
    tags: ["research", "browser"],
    // ...
  },
  {
    name: "bash",
    tags: ["shell", "code"],
    // ...
  }
];
```

### mapping в config/defaults.ts

```typescript
experts: {
  code: {
    model: "qwen3.5-9b",
    tool_tags: ["file", "code", "shell"]
  },
  research: {
    model: "qwen3.5-9b",
    tool_tags: ["research", "browser", "file"]
  },
  browser: {
    model: "qwen3.5-9b",
    tool_tags: ["browser", "research"]
  },
  vision: {
    model: "gpt-4o",
    tool_tags: ["browser", "vision"]
  }
}
```

## Overlap prevention

- `allowed_files` — write/delete scope. Subtask может создавать, изменять и удалять только эти файлы.
- `read_only_files` — read scope. Subtask может читать эти файлы, но не изменять.
- Pre-flight check:
  - **Два subtask не могут иметь общий путь в `allowed_files` ни при каких зависимостях.** Router должен merge такие задачи в один subtask или перепроектировать план так, чтобы каждый файл писался только одним subtask.
  - `read_only_files` одного subtask могут пересекаться с `allowed_files` другого subtask только при `depends_on` (read-after-write).
  - Если subtask удаляет файлы (`delete_file`, `move_file` без цели в scope), система проверяет, что ни один другой subtask (включая зависимые от этого) не читает удаляемые файлы. Если читает — добавляется `depends_on` на удаляющий subtask или план reject.
- Runtime guard: `read_file`, `write_file`, `edit_file`, `bash`, `move_file` и т.д. проверяют `allowed_files` и `read_only_files` через контекст subagent.
- Если subtask пытается писать в `read_only_files` или читать файл вне обоих списков — tool возвращает ошибку.

## Failure handling

- Если subtask падает — остальные продолжают выполняться.
- Router получает partial results и ошибки.
- Router решает:
  - partial достаточно для merge (ответ с предупреждением);
  - нужно retry упавшего subtask;
  - нужен re-plan (max 3 цикла).

## Retry policy

- Каждый `expert_tag` в конфиге может иметь `max_attempts` (default: 2).
- Retry применяется к транзиентным ошибкам: таймаут сети, flaky browser, 5xx от LLM-провайдера.
- Retry **не** применяется к ошибкам scope, syntax errors или нарушению success criteria — для них используется re-plan.
- Для цепочек зависимых subtasks (например, vision → browser) можно указать `chain_max_attempts` в плане. Если t6 падает из-за плохих селекторов от t5, Router может перезапустить цепочку `t5 → t6` до `chain_max_attempts` раз.

```typescript
experts: {
  browser: {
    model: "qwen3.5-9b",
    tool_tags: ["browser", "research"],
    max_attempts: 3
  },
  vision: {
    model: "gpt-4o",
    tool_tags: ["browser", "vision"],
    max_attempts: 2
  }
}
```

## Re-plan loop

- Если verify/merge не прошёл, Router получает:
  - исходный план;
  - результаты и ошибки;
  - замечания verifier.
- Router возвращает новый план.
- Лимит: 3 цикла. После — финальный ответ с объяснением, что не удалось.

## Post-MVP enhancements

### Scope expansion

В MVP subagent не может расширять свой scope. Если нужен файл вне `allowed_files`/`read_only_files`, subagent возвращает ошибку, а Router делает re-plan.

После MVP можно добавить надёжный механизм scope expansion:

1. Subagent обнаруживает, что для выполнения задачи нужен файл вне scope.
2. Вместо попытки доступа subagent возвращает special result: `scope_request: { files: string[], reason: string, read_only: boolean }`.
3. Router получает scope request и решает:
   - **approve** — добавить файлы в `read_only_files` (или `allowed_files`, если subagent доказал необходимость write) и перезапустить subtask;
   - **redirect** — создать новый subtask для работы с этими файлами;
   - **reject** — оставить текущий scope; subtask считается failed.
4. Scope expansion не разрешается автоматически — только через явное решение Router. Это сохраняет isolation и predictability.

Этот механизм не входит в MVP.

## Интеграция с MMA v2

### Уже есть

- `tools/subagent.ts` — Level 2.
- `modules/session/` — sub-session + summary.
- `modules/execution/verifier.ts` — verify loop.
- `tools/plan.ts` — декомпозиция.
- `llm/orchestrator.ts` — большая модель для conflict resolution.

### Что нужно изменить

1. `tools/registry.ts` — добавить `tags` к каждому инструменту.
2. `config/defaults.ts` — добавить раздел `experts` с `tool_tags` и `model`.
3. `llm/orchestrator.ts` — добавить режимы `plan` и `verify/merge`.
4. `tools/subagent.ts` — принимать `expert_tag`, `allowed_files`, `read_only_files`, `shared_context`, `max_tokens`.
5. `modules/execution/` — добавить overlap check и re-plan loop.
6. `core/prompt-builder.ts` — фильтровать инструменты по тегам эксперта.
7. `tools/registry.ts` — добавить `vision` tag к `browser.screenshot` (или выделить отдельный vision tool).

## Resolved decisions

1. **Budget** — каждый subtask получает `max_tokens`. Router может не задавать его, тогда система использует default из `experts[tag].max_tokens` или общего конфига.
2. **depends_on** — строгий DAG. Валидация проверяет отсутствие циклов. Выполнение — топологическая сортировка, параллельно там, где нет зависимостей.
3. **Vision** — отдельный `expert_tag: 'vision'`. В model config указывается vision-совместимая модель; tool group включает `browser.screenshot` и другие необходимые инструменты.
4. **Validation of `shared_context.rules`** — LLM-only + consistency check. Правила включаются в prompt каждого subagent; Verifier и consistency check следят, чтобы результат не противоречил правилам.
5. **Read/Write scope** — в subtask два поля: `allowed_files` (write/delete) и `read_only_files` (read). Write-write пересечения `allowed_files` запрещены всегда, даже с `depends_on`. Read-write пересечения допустимы только при `depends_on` (read-after-write).
6. **Verification commands** — глобальные команды (`tsc`, `bun test`) запускает Router в фазе verify/merge, а не subagent внутри своего execution.
7. **Cross-expert result flow** — результаты между subtasks передаются через `input_from`, указывающее `subtask_id` и `field` результата.
8. **Retry policy** — каждый expert_tag имеет `max_attempts` для транзиентных ошибок; цепочки зависимых subtasks имеют `chain_max_attempts`.

## Ссылки

- `docs/specs/2025-07-28-mma-v2-design.md`
- `AGENTS.md` — правила #8, #9, #10
- `src/llm/orchestrator.ts`
- `src/tools/subagent.ts`
- `src/modules/execution/verifier.ts`
