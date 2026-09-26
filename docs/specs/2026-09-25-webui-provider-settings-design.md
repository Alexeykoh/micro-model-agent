# Web UI: «Модель и провайдер» — редизайн панели настроек

Дата: 2026-09-25
Ветка: `feat/webui-markdown` (или отдельная `feat/webui-provider-settings`)

## Проблема

В настройках web-UI панель «Модель и провайдер» — единый поток без группировки:

- поиск, список моделей, строка «активный провайдер», список провайдеров и ссылка
  «добавить провайдера» идут подряд, без заголовков и разделителей;
- строка «активный провайдер» визуально неотличима от строки модели (`openai-compat … openai-compat активен изменить`);
- кнопка добавления провайдера приклеена снизу и не читается как действие;
- строка провайдера тесная (имя + тип + статус + действия в одну строку).

## Что делают зрелые продукты (исследование)

- **Open WebUI** (Admin → Connections): список «Manage OpenAI API Connections», кнопка
  **➕ Add Connection** рядом с заголовком секции; подключение — раскрываемая карточка
  (Name необязательно, Provider, Base URL обязателен, API Key); каталог моделей —
  отдельно, с поиском, бейджем провайдера и «Make default» в строке.
- **Libre WebUI**: «Model Catalog» с бейджем провайдера, поиском и «Make default» на строке.
- **Android settings guidelines**: группировать настройки заголовком + разделителем;
  избегать generic-подписей («изменить/использовать/настроить»); редкие действия — в overflow.
- **SaaS / Cloudscape / SaaSUI**: сложные формы — в отдельной поверхности, но **нельзя
  вкладывать модалку в модалку**; inline-edit — для мелких частых правок; деструктивные
  действия отделять и подтверждать; действие добавления — на уровне секции.

## Выбранный вариант (A+)

Секционная раскладка + добавление в шапке секции + inline-форма (без новых модалок).

```
Модель и провайдер                      ← существующий h3 панели

[ поиск моделей… ]

МОДЕЛЬ ─────────────────────────────────────────────
  qwen/qwen3.5-9b            32K · активна ✓
  north-mini-code-1.0                использовать
  …                          (список со скроллом)

ПРОВАЙДЕРЫ                                [+ добавить]
▸ openai-compat  [активный]
    openai-compat · 32K · rpm 60 · x1
    [сделать активным] [изменить]
▸ другой-провайдер
    openai-compat
    [сделать активным] [изменить] [удалить]

  ┌ добавить провайдера (inline) ────────────────┐
  │ тип*  метка  base URL*  API key             │
  │ ▸ дополнительно (context / priority / rpm)   │
  │ [сохранить] [отмена]                         │
```

### Решения

1. **Убрать дублирующую строку «активный провайдер»** — активность показывается бейджем
   `[активный]` на строке провайдера.
2. **Две секции** с подзаголовками `.sec-head` («МОДЕЛЬ», «ПРОВАЙДЕРЫ»): модели и
   провайдеры больше не сливаются.
3. **Кнопка «добавить» в шапке секции провайдеров** (паттерн Open WebUI):
   `<button aria-expanded>` с иконкой `+`; повторное нажатие сворачивает форму.
4. **Строка провайдера** — по образцу существующего `.skill-item`: имя + бейдж, вторая
   dim-строка метаданных, ниже чипсы действий (`сделать активным` / `изменить` / `удалить`).
   «Удалить» — только для неактивных, с существующей серверной защитой `active-provider`.
5. **Inline-форма** с заголовком «добавить/изменить провайдера», обязательные поля сверху
   (тип, base URL), необязательные в свёрнутом `<details> «дополнительно»`
   (contextWindow / priority / rpm / parallel). `datalist` подсказывает известные типы
   (`openai-compat`, `openrouter`, `openai`, `anthropic`, `opencode-zen`, `opencode-go`)
   и типовые base URL (LM Studio, Ollama, OpenRouter, OpenAI).
6. **Модели**: поиск + скроллируемый список, активная модель выделена; действие
   «использовать» на строке.
7. **A11y**: реальные `<button>`, `aria-expanded` на тумблере формы, автофокус в первое
   поле при открытии, отмена/Esc закрывают форму, `aria-label` на иконке.
8. **Локализация** en+ru; новые ключи `web.settings.section_models`,
   `section_providers`, `provider_add_title`, `provider_edit_title`, `provider_advanced`,
   `provider_make_active`.

### Что не меняем

- Только панель `data-panel="model"` и scoped CSS (`.settings-section`, `.provider-item`,
  `.pform-*`, `.chip`). Остальные вкладки настроек и их `.row`/`.settings-list` не трогаем.
- API `/api/providers` и формат конфига без изменений — форма шлёт тот же body.
- Модалка настроек остаётся одна (новых модалок нет).

## Тестирование

- `tests/webui-assets.test.ts`: source-guard на новые классы/ключи (`.provider-item`,
  `.sec-add`, `provider_make_active`).
- Ручной прогон: `bun run mma web` → настройки → «Модель и провайдер»: добавить,
  изменить, сделать активным, удалить; проверить светлую/тёмную тему и узкое окно.
- `bun test`, `bun run quality`.

## Follow-up (same release): multi-provider ergonomics

Two of the three original limitations were addressed; the third was deliberately left.

1. **Per-provider model memory** — `provider.models[name]` (additive) records the model
   used with each provider; switching `provider.active` restores it. Hooked once in
   `setConfigValue` (`src/config/registry.ts`), so `/model`, `/provider use`, the web
   selectors and the settings panel all share one path. Web `postConfig` re-reads
   `/api/config` + `/api/models` after a provider/model change.
2. **Unique provider names** — `providerNameTaken` (`src/modules/providers/naming.ts`)
   rejects a new/renamed provider that collides with another entry's `label` or `type`
   (`409 name-conflict` / `cli.provider_name_conflict`). Web edits send `originalName`
   so an entry can keep its own name; POSTs without `originalName` are pure creates.
3. **Deleting the active provider** — unchanged: still `409 active-provider` ("switch
   first"), matching the Oracle-style guard. Rationale: the current refusal is already a
   clear, safe non-dead-end; auto-promotion was judged YAGNI.

