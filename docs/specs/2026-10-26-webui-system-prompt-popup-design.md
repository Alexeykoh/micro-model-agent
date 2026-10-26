# WebUI: поп-ап системного промпта (2026-10-26)

## Задача

Trace показывает события хода, но не даёт увидеть, **из чего собран системный
промпт** и какая его версия реально ушла модели. Кнопка в Trace открывает
поп-ап с полным текстом и разбивкой по блокам (label, priority, tokens,
included/excluded).

## Контракт

### Core API

`Agent.getSystemPromptInfo()` расширяется аддитивно:

```ts
{
  text: string;
  tokenCount: number;
  excluded: string[];
  blocks: Array<{ label: string; priority: string; tokens: number; included: boolean }>;
}
```

`blocks` — та же разбивка, что уже пишется в `context`-событие `session.jsonl`
(одна точка сборки — `buildSystemPrompt`).

### REST

`GET /api/sessions/:id/system-prompt`

- Auth/same-origin — общий слой `server.ts`, как у остальных session-роутов.
- Раннер сессии берётся из `RunPool.getRunner(id)`.
- Раннер есть → `200`:

```json
{
  "available": true,
  "text": "...",
  "tokenCount": 1234,
  "excluded": ["..."],
  "blocks": [{ "label": "system", "priority": "high", "tokens": 900, "included": true }]
}
```

- Раннера нет (сессия ещё не ходила в этом процессе) → `200`:

```json
{ "available": false, "reason": "no_active_runner" }
```

Без менеджера/пула — `503 { "error": "sessions_unavailable" }`.

### UI

- В панели Trace — кнопка `Prompt` (i18n `web.sidebar.prompt_open`).
- Поп-ап: заголовок, токены, список блоков (`label · priority · tokens`,
  `excluded` помечается), полный текст в `<pre>`.
- `available:false` → спокойная строка «промпт появится после первого хода»
  (i18n `web.sidebar.prompt_no_runner`).
- Закрытие: кнопка `✕`, клик по фону, `Escape`.

## Границы

- Только чтение: ни промпт, ни состояние сессии не мутируются.
- Поп-ап не грузит промпт при открытии Trace; запрос — только по кнопке.
- Промпт может содержать секреты из памяти/профиля — поп-ап локальный,
  ничего не логирует и не отправляет наружу.

## Проверки

- `tests/webui-system-prompt-api.test.ts`: есть раннер / нет раннера / нет пула.
- `tests/core/system-prompt-model-block.test.ts` (или agent): `blocks`
  присутствуют и согласованы с `text`.
- `tests/webui-xss-guard.test.ts`: новые DOM-вставки — только `textContent`,
  не `innerHTML`.
