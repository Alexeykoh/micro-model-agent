# Отзыв черновика виден: кто, почему и что это штатно

_Дата: 2026-10-30. Долг: A13 (P0)._

## Что сейчас (наблюдение)

Гейт проверки может забраковать **уже отстримленный** ответ: критик
(`CriticGate.injectAdvice`/`injectRepair`), проверка заявлений
(`hallucination-claims.ts::retractDraft`) или финальный аудит (`AuditGate`).
Во всех трёх местах в чат уходила одна и та же метка
`t("ui.draft_retracted")` с `kind: "retract"`.

Следствия для пользователя `mma web`:

- ответ **молча исчезает** из ленты: видимого следа, что он был и почему
  отозван, не остаётся;
- в Trace висит «черновик отозван» без виновника и причины, рядом с
  `critic · critical`, но без связи между ними;
- маскот уходит в `error` — штатная перепроверка выглядит как поломка
  харнесса;
- критик и проверка фактов в UI неотличимы, хотя это разные гейты.

## Контракт события `retract`

`OnMeta` получает третий необязательный аргумент — структурированные детали
отзыва; сырой текст метки (`chunk`) остаётся первым аргументом, поэтому
терминальный рендер и все прочие потребители `meta` не меняются.

```ts
export type RetractSource = "critic" | "hallucination" | "audit";

export interface RetractInfo {
  source: RetractSource;
  /** Короткая причина: summary/первое issue критика, claim или причина повтора. */
  reason?: string;
  /** Итерация петли — ключ связи с `critic_verdict`/`claim_retry` в логе. */
  iteration?: number;
  /** Статус/вид вердикта (`critical`, `concern`, `success`, `artifact`, …). */
  verdict?: string;
}

export type OnMeta = (meta: string, kind?: MetaKind, info?: RetractInfo) => void;
```

SSE-событие `retract` (плоская форма, без вложенных объектов):

| поле        | тип                                      | смысл                                                                            |
| ----------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| `type`      | `"retract"`                              | тип события                                                                      |
| `ts`        | number                                   | время                                                                            |
| `reason`    | string                                   | **краткая причина для человека** (summary/issues/claim)                          |
| `label`     | string                                   | сырой локализованный текст метки (`ui.draft_retracted`) — обратная совместимость |
| `source`    | `"critic" \| "hallucination" \| "audit"` | кто отозвал; отсутствует у сторонних плагинов                                    |
| `iteration` | number?                                  | итерация петли                                                                   |
| `verdict`   | string?                                  | статус/вид вердикта                                                              |

Правила:

- `reason` без структуры (плагин позвал `onMeta(x, "retract")`) деградирует до
  `label`; `source` тогда не выставляется, UI пишет нейтральное «проверка».
- Причина обрезается до 160 символов: лента и Trace — одна строка (STYLE).
- Отзыв — **не ошибка**: `turn_end` по-прежнему несёт свой `success`; отзыв
  лишь означает, что модель переписывает ответ.

## Поведение UI

1. **Лента (`feed/stream.ts::onRetract`).** Черновик по-прежнему удаляется
   (иначе финал встанет дублем), но вместо тихого исчезновения появляется
   видимая плашка:
   `↺ черновик отозван: критик — не хватает тестов`.
   Класс `metaln retract` (не `warn`, не `errline`), цвет `--dim-b`.
   Имя источника — `web.feed.retract_source_{critic,hallucination,audit,check}`,
   вся строка — `web.feed.retract_line`; без причины — `web.feed.retract_no_reason`.
2. **Маскот (`loader.ts`).** Новое состояние `recheck` (`st-recheck`,
   recon-цвет, взгляд вбок) — «перечитываю и переписываю». `retract` больше
   не мапится в `error`; `error` остаётся сбоям харнесса.
3. **Trace (`sidebar/trace.ts`).** Строка retract несёт `source`, `reason`,
   `iteration`, `verdict`; заголовок — `черновик отозван · критик`; в detail —
   источник и пояснение «штатная перепроверка: гейт отозвал черновик до
   переответа», плюс итерация. По `iteration` строка стыкуется с
   `critic_verdict` той же итерации из supplement-лога; в `isWarn` retract
   не входит.

## Что сознательно не делаем

- Не трогаем рендер Markdown (`feed/render.ts`) и анимационную систему MMART:
  новое состояние — только класс, иконка и CSS-правила.
- Не добавляем отдельного SSE-канала: `retract` уже есть, меняется payload.
- Не показываем техническую причину критика в чате — только его summary.
- Не меняем `session.jsonl`: `critic_verdict`/`claim_retry` уже несут
  `iteration` и причину.

## Проверка

- `tests/webui/retract-visible.test.ts`:
  - форвардер: `retract` несёт `source`/`reason`/`iteration`/`label`, без
    структуры — `reason` = `label` и нет `source`;
  - лента: черновик удалён, плашка `.metaln.retract` видна, содержит имя
    источника и причину, не имеет класса `warn`;
  - `loaderStateFor({type:"retract"}) === "recheck"` и `!== "error"`;
  - critic и hallucination дают разные плашки/`source`; trace-строка несёт
    источник и итерацию.
- Обновлены `tests/webui-loader.test.ts`, `tests/webui-forward-retract.test.ts`,
  `tests/critic-gate.test.ts`, `tests/core/agent-audit-gate.test.ts`,
  `tests/core/agent-claim-check.test.ts` — старые ожидания «retract = error»
  и «ровно два аргумента onMeta» больше не верны.
- `tests/webui-assets.test.ts` читает SSE-обвязку из общего бандла (`js(a)`):
  проводка переехала из `app.ts` в `js/sse.ts`, смысл guard'ов не изменился.
- `gh-pages/` получил состояние `recheck` (гейт `landing-accuracy` сверяет
  набор состояний маскота с `FaceState`).
- `bun run typecheck`, `bun run typecheck:frontend`, точечные тесты.

## Риски

- **Шум.** Плашка появляется только когда черновик реально был в ленте
  (`hadDraft`); ходы без видимого текста остаются тихими.
- **Длинная причина.** Summary критика бывает предложением — кап 160 символов
  и `overflow-wrap` держат одну строку.
- **Сторонние плагины** зовут `onMeta(...,"retract")` без структуры: плашка
  покажет нейтральное «проверка» и сырой текст, что честнее молчания.
