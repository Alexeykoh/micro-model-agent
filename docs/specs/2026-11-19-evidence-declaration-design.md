# Декларация класса доказательства шага плана

> Дата: 2026-11-19 · Ветка: `fix/evidence-class-no-keywords`
> Нормативно для: `plan`/`plan_step`, final audit, done-гардов, auto-advance.

## 1. Контекст

Сессия `ses_mwmeoln9_bvaqcemvdcxomgyq`: агент изменил логику движения, написал тесты под текущую
реализацию, закрыл план галочками и сообщил «готово». Игра при этом не двигалась: `step()`
обнулял аккумулятор каждый кадр, а все тесты вызывали функцию одним тиком с `dt == cooldown`.
Финальный аудит не поймал это, потому что `autoCloseEvidenceSteps()` закрыл шаг по факту
существования файлов.

Второй дефект — сам механизм распознавания «поведенческого» шага: `isBehaviorStep()`
(`plan-checks.ts`) классифицирует шаг по EN/RU-стемам в описании. Это нарушает правило №10
(`docs/agents/architecture.md`): никакой классификации по ключевым словам, только декларативные
данные и структурные сигналы.

## 2. Цели

1. Убрать keyword-эвристику из решения о классе доказательства.
2. Сохранить защиту от «build зелёный, страница пустая» (дефект F спеки 0.25.2), но перевести её
   на декларативное поле шага.
3. Запретить final audit авто-закрывать шаг, для которого требуется поведенческое доказательство.

Классификация шага как поведенческого больше не выводится из текста описания — это решение
принимает модель при создании плана.

## 3. Не входит в объём

- Изменение формата `session.jsonl` сверх добавления одного опционального поля шага.
- Автоматический запуск Playwright (только по явной команде пользователя).
- Новые префиксы `check:` — контракт `CheckKind` остаётся прежним.
- Правка кода игры в `/workspace/core` — это другой проект и другая ветка.

## 4. Контракт

В `PlanStep` добавляется опциональное поле:

```ts
evidence?: "static" | "behavioral";
```

- `"behavioral"` — модель **явно объявляет**: шаг меняет наблюдаемое поведение/UI и не принимает
  статическое доказательство (`file-exists:`, `file-modified:`, build-команда).
- `"static"` или отсутствие поля — шаг доказывается статикой; сохраняет back-compat со всеми
  существующими планами.

Источник значения — параметр `evidence` тула `plan` (массив, 1:1 со `steps`), передаваемый на
`create`/`re-plan`. Модель решает сама по сложности шага; харнесс не угадывает по тексту.

### 4.1. Правила enforcement (одна точка — `plan-checks.ts`)

| Сигнал | Поведение |
| --- | --- |
| `evidence === "behavioral"` + `classifyCheck(check) === "static"` | done заблокирован (`plan.check_need_behavior`) |
| `evidence === "behavioral"` + `manual:` без заметки | done заблокирован (`plan.manual_needs_note`) |
| `evidence === "behavioral"` в `isUnconfirmed()` | `manual:` без заметки = шаг не подтверждён |
| `evidence === "behavioral"` в auto-advance | `manual:` без заметки шаг не закрывается |
| `evidence === "behavioral"` в `autoCloseEvidenceSteps()` | шаг **никогда** не авто-закрывается по файлам |

Проверка `check` остаётся структурной: `parseCheck()` → `classifyCheck()` → `BUILD_COMMANDS`
(фиксированный список, INV-G3). Никакого regex/стем по описанию шага.

## 5. Изменения по файлам

- `src/modules/execution/planner.ts` — поле `PlanStep.evidence`, параметры `createPlan`/`replan`,
  вывод в prompt-блоке.
- `src/modules/execution/plan-checks.ts` — удалить `BEHAVIOR_STEMS_*` и `isBehaviorStep()`;
  `StepEvidenceTarget.evidence`; `staticEvidenceForBehaviorStep()` читает поле.
- `src/modules/execution/final-audit.ts` — `isUnconfirmed()` и `autoCloseEvidenceSteps()` читают
  `step.evidence`.
- `src/modules/execution/step-update.ts`, `step-advance.ts`, `step-check-contract.ts` — передача
  декларативного поля вместо анализа описания.
- `src/modules/execution/plan-tool.ts`, `plan-actions.ts`, `module.ts` — параметр `evidence`,
  парсер и передача в `createPlan`/`replan`.
- Описание тула `plan`: инструкция модели объявлять `evidence: "behavioral"` для шагов, меняющих
  наблюдаемое поведение.
- `docs/agents/gates.md` — новая строка инварианта.

## 6. Гейты

- `tests/execution/verify-evidence-class.test.ts` — вместо keyword-кейсов: объявленный
  `"behavioral"` блокирует статический check; не объявленный — не блокируется; описание шага
  не влияет на решение.
- `tests/execution/auto-close-behavior.test.ts` — шаг с `evidence:"behavioral"` не авто-закрывается
  `autoCloseEvidenceSteps()`.
- `tests/execution/plan-evidence-tool.test.ts` — `evidence` из аргументов тула доходит до
  `PlanStep` и сохраняется при `re-plan`.
- Строка в `docs/agents/gates.md`: «поведенческий шаг не закрывается статикой → тесты выше».

## 7. Совместимость и миграция

- Планы без `evidence` ведут себя как `"static"` — все записанные `session.jsonl` читаются без
  миграции.
- Старые планы с UI-шагами и `file-exists:` потеряют keyword-защиту; это осознанный откат
  эвристики, компенсируется инструкцией в описании тула и явной декларацией новых планов.
- `CHANGELOG.md` не трогается (правка только по явной команде).

## 8. Definition of done

`bun test` и `bun run quality` зелёные; тесты из §6 падали бы без правки; ссылки в доке
резолвятся (`tests/docs-link-check.test.ts`).
