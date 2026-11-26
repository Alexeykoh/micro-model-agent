# Спека: редактирование возможностей модели через `mma web`

Дата: 2026-11-20 · Ветка: `feat/web-model-capabilities` · Статус: согласовано

## 1. Проблема

У `llama.cpp`-модели `bonsai-2-27b-pq2` `/props.chat_template_caps` объявляет
`supports_reasoning_effort: true`, но **не** отдаёт `reasoning_effort_levels`
(у `bonsai-2-27b` список `["low","medium","xhigh"]` есть). По INV-R7 харнесс не
выдумывает уровни: `reasoningLevels` остаётся `undefined`, селектор показывает
только `auto`/`default`, а проба с каноническим `high` получает 500 от шаблона,
принимающего `xhigh|medium|low`.

Ручной обход уже есть — `config.modelCapabilities[model]` в `provider.json`
имеет наивысший приоритет в `resolveModelCapabilities` (override → probe →
preset). Но через `mma web` этот обход недоступен: реестр-валидатор ключа
`modelCapabilities` (`src/config/registry-extra-capabilities.ts`) разрешает
только `vision/video/audio/pdf/tools`, а таблица в настройках содержит те же
пять колонок. Поля `reasoningStrategy`/`reasoningOff`/`reasoningLevels`都是通过
`/api/config` отклоняются как `invalid-value`.

## 2. Решение

Единый публичный ключ `modelCapabilities` остаётся источником правды. Делаем
его полностью редактируемым из веба двумя согласованными поверхностями:

- **Основной путь (UX):** в Settings → Model → вкладка Models у каждой строки
  модели кнопка «изменить» открывает вложенный диалог (`openSubDialog`) со
  всеми полями возможностей этой модели. Save — один `POST /api/config`.
- **Существующий путь:** таблица во вкладке Capabilities расширяется теми же
  полями, чтобы сохранение из неё не стирало reasoning-настройки (таблица
  переотправляет всю запись целиком).

### 2.1. Конфиг/валидатор

`CAPABILITY_DEFS` (`src/config/registry-extra-capabilities.ts`):

1. Предикат формы `modelCapabilities` дополняется:
   - `reasoningStrategy` — строка из `"openai-effort" | "template-kwarg" |
     "prompt-tag" | "none"`;
   - `reasoningOff` — `boolean`;
   - `reasoningLevels` — массив строк; пустой массив допустим и означает
     «выключатель есть, гранулярных уровней нет» (INV-R7).
   - Неизвестные поля записи по-прежнему игнорируются валидатором (обратная
     совместимость старых конфигов), обязательных полей нет — запись может
     содержать любое подмножество.
2. Деф получает эффект `REBUILD` (через spread поверх `jsonShape(...)`, чтобы
   не менять сигнатуру фабрики и не задевать остальные json-ключи). Это даёт
   немедленный `persistAndReconfigure` в `/api/config`: провайдер
   пересобирается с новым оверрайдом без перезапуска и без смены модели.

`src/config/defaults.ts` не меняется (`modelCapabilities: {}` уже есть).
Формат `provider.json` расширяется лишь уже объявленными полями
`ModelCapabilities` (`src/config/types.ts`), новый ключ не вводится.

### 2.2. Веб-диалог

Новый модуль `src/modules/webui/assets/js/settings/model-capabilities-form.ts`
(≤300 строк, без innerHTML):

- экспортирует дескриптор полей (ключ, тип, i18n-метка, опции) и функцию
  открытия диалога `openModelCapabilitiesDialog(model: string)`;
- читает текущую запись из `settings.config.modelCapabilities?.[model]`;
  пустые поля = нет оверрайда;
- подсказку «обнаружено» показывает **только для активной модели**: данные
  `settings.capabilities` и `settings.reasoning` приходят из `/api/models`
  только для активной пары; для остальных моделей подсказки нет;
- кнопки: Save, Reset (удалить запись этой модели), Cancel;
- Save/Reset собирают весь объект `modelCapabilities`, сливая новую запись с
  оверрайдами остальных моделей, и вызывают
  `postConfig("modelCapabilities", next, true)` ровно один раз; диалог
  закрывается только после успешного ответа;
- ошибки записи (в том числе 409 `busy`) остаются в существующем канале
  `postConfig` → индикатор/тост; диалог в этом случае остаётся открытым.

В `model-panel.ts` (`modelsPane`) в каждую строку модели добавляется кнопка
`web.settings.model_capabilities.edit`, открывающая диалог. Кнопка доступна
для всех моделей списка активного провайдера, не только для активной.

### 2.3. Таблица Capabilities

В `PANEL_SECTIONS.model` секция `model.capabilities` остаётся на месте; в
дескрипторе редактора (`registry-extra-capabilities.ts`) добавляются колонки
`reasoningStrategy` (статический select), `reasoningOff` (bool),
`reasoningLevels` (массив через запятую) и `layout: "stack"` — по образцу
таблицы `experts`.

`table-editor.ts` получает минимальную поддержку опции колонки `options: string[]`
для статического select (сейчас есть только `optionsSource` для live-списков
моделей/провайдеров); поведение `build()`/`writeValue` для строк не меняется.

### 2.4. Локализация

Симметрично в `src/i18n/en.json` и `ru.json`:

- `config.field.reasoningStrategy`, `config.field.reasoningOff`,
  `config.field.reasoningLevels` (метки полей таблицы и формы);
- `web.settings.model_capabilities.edit`, `.title`, `.detected`, `.reset`
  (остальное — существующие `web.settings.save/cancel`, `web.dialog.close`).

## 3. Границы

- Новых REST-эндпоинтов, SSE-событий и ключей конфига нет: запись идёт через
  существующий `POST /api/config {key, value}`; рассылка `config` уже
  обновляет открытые панели.
- Реестр не хранит «текущий провайдер» в записи: `modelCapabilities` —
  глобальный ключ по id модели (существующий контракт). Одинаковые id у двух
  провайдеров делят оверрайд; это известное ограничение, в этой волне не
  меняется.
- Пустой `reasoningLevels: []` не подменяется выдуманными уровнями ни в UI,
  ни на проводе (`normalizeReasoningEffort`).
- Без явной команды не трогаются `CHANGELOG.md` и версия пакета.

## 4. Проверки

- `tests/config/model-capabilities.test.ts` (или ближайший существующий
  файл): валидатор принимает новые поля/подмножества и отвергает неверный
  `reasoningStrategy` и не-строки в `reasoningLevels`; деф несёт `REBUILD`.
- Чистые функции построения записи формы и проекции подсказки — юнит-тесты
  без DOM.
- DOM-тест в стиле `tests/webui-*-dom.test.ts`: кнопка у модели открывает
  диалог, Save отправляет объединённую запись, Reset удаляет только текущую
  модель, при ошибке диалог не закрывается.
- i18n-симметрия (`tests/i18n.test.ts`), `tests/webui-i18n.test.ts`,
  гейты `tests/arch/*`, `tests/output/*`, потолок 300 строк, webui-boundaries.
- Локальный прогон: `bun test` и `bun run quality`. Playwright/E2E — только по
  явной команде пользователя (правило репо).

## 5. Ветка и релиз

Работа ведётся в `feat/web-model-capabilities`, ответвлённой от `dev`.
Интеграция — в `dev` слиянием после зелёных `bun test` и `bun run quality`;
в `master` напрямую не коммитим. Версия и CHANGELOG не меняются: правка не
является релизом и не требует bumps по правилам беты.
