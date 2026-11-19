# MMA Web — переработка шагов первой настройки (design)

**Date:** 2026-11-17
**Branch:** `feat/web-setup-rework`
**Status:** Approved (implementation)
**Related:** [`2026-09-25-web-first-run-design.md`](../archive/specs/2026/2026-09-25-web-first-run-design.md),
[`2026-10-30-webui-theme-persistence-design.md`](./2026-10-30-webui-theme-persistence-design.md),
[`2026-10-31-webui-sounds-design.md`](./2026-10-31-webui-sounds-design.md)

---

## 1. Problem

Визард `mma web` повторяет терминальный сценарий один-в-один: 7 технических
шагов, знакомство приклеено к шагу языка, настройки агента (критик, веб-поиск,
тема, звуки) в первой настройке отсутствуют. Пользователь выходит из визарда,
попадает в пустой чат и не знает, что агент умеет.

Цель переработки — короткое знакомство, явный выбор «настроить провайдера или
взять дефолт», отдельная группа настроек агента и финальная проверка запуском.

## 2. Goals

- Разделить знакомство и выбор языка.
- Спросить, нужна ли настройка провайдера и модели, и дать безопасный пропуск.
- Оставить шаги Provider / Key / Model / Security без изменения поведения.
- Добавить режим «Авто» для окна контекста.
- Добавить шаги «Критик», «Веб-поиск», «Тема и уведомления».
- Финальная проверка: реальный короткий запрос к модели.
- Сохранять черновик визарда между перезагрузками вкладки (без API-ключа).
- Доступность: фокус при смене шага, `aria-current`, `aria-live`, `Esc` в попапах.

## 3. Non-goals

- Повторный запуск визарда на настроенном инстансе (`mma web --setup`) — отдельная задача.
- Стартовые карточки-подсказки в пустом чате — отдельная задача после визарда.
- `meet`-интервью (профиль/домен) в браузере.
- Мультипровайдер/failover и тонкая настройка модели (temperature, reasoning).
- Браузерные desktop-уведомления; «уведомления» = звуки веб-UI.
- Изменение рабочей папки из UI: workspace фиксируется при запуске (`mma web -d`).

## 4. Target flow

| # | Step id | Название |
|---|---|---|
| 1 | `welcome` | Знакомство |
| 2.0 | `provider-choice` | Провайдер и модель: настроить или пропустить |
| 2.1 | `provider` | Провайдер (без изменений) |
| 2.2 | `key` | Ключ (без изменений) |
| 2.3 | `model` | Модель (без изменений) |
| 2.4 | `context` | Контекст (+ Авто/Вручную) |
| 3.0 | `agent` | Настройка агента (разделитель) |
| 3.1 | `critic` | Критик |
| 3.2 | `websearch` | Веб-поиск |
| 3.3 | `appearance` | Тема и уведомления |
| 3.4 | `security` | Безопасность (без блока звуков) |
| 4.0 | `review` | Проверка настроек |

Полоса прогресса — 4 группы: `Знакомство · Провайдер · Агент · Проверка`.
Текущая группа акцентируется, пройденные получают `✓`.

### 4.1. Шаг 2.0 и семантика «пропустить»

Визард открывается только на virgin-конфиге (`setupRequired` = нет
`config.json`). Поэтому «пропустить» не может означать «у меня уже всё
настроено»: конфига нет. Единственная честная семантика — **использовать
дефолты**:

- `provider = openai-compat`
- `apiBase = http://localhost:1234/v1`
- `model = qwen/qwen3.5-9b` (`DEFAULTS.model`)
- `contextWindow = 32768`, `maxToolIterations = 200`

Шаг показывает текущие дефолты и результат автоскана локальных серверов.
Если скан ничего не нашёл — предупреждение, но пропуск разрешён: сервер может
быть запущен позже, а чат после настройки всё равно откроется.

`configureProvider = false` в `POST /api/setup` означает: не трогать
`provider`, `model`, `contextWindow`, `maxToolIterations`, `contextAuto`.

## 5. Contracts

### 5.1. `GET /api/setup`

Дополняется:

```jsonc
{
  "required": true,
  "languages": [/* без изменений */],
  "providers": [/* без изменений */],
  "defaults": {
    "contextWindow": 32768,
    "maxToolIterations": 200,
    "contextAuto": true,
    "security": { /* без изменений */ }
  },
  "workspace": "/abs/path",
  "current": {
    "provider": "openai-compat",
    "apiBase": "http://localhost:1234/v1",
    "model": "qwen/qwen3.5-9b",
    "contextWindow": 32768,
    "contextAuto": true,
    "criticEnabled": true,
    "webSearchEnabled": true,
    "ui": { "theme": "console", "themeMode": "auto", "themeEffects": true,
            "sounds": { "enabled": true, "done": true, "question": true,
                        "failed": true, "volume": 50 } }
  }
}
```

`current` читается из живого `s.config` (на virgin-конфиге — дефолты).
Секреты не возвращаются.

### 5.2. `POST /api/setup` — `SetupAnswers`

Новые опциональные поля (обратная совместимость с терминальным визардом и
демоном):

| Поле | Тип | Правило |
|---|---|---|
| `configureProvider` | boolean | `false` — не трогать провайдера/модель/контекст/итерации |
| `contextAuto` | boolean | `true` — авто-режим окна контекста |
| `criticEnabled` | boolean | `config.critic.enabled` |
| `webSearchEnabled` | boolean | `config.webSearch.enabled` |
| `theme` | string | один из `UI_THEME_IDS` |
| `themeMode` | `"dark" \| "light" \| "auto"` | из `THEME_MODES` |
| `themeEffects` | boolean | `config.ui.themeEffects` |
| `sounds` | object | частичный `ui.sounds`; каждое поле валидируется |

Существующие поля `provider/apiBase/model/contextWindow/maxToolIterations`
остаются обязательными **только при** `configureProvider !== false`.
Невалидные новые поля отбрасываются по одному (fail-open к текущему конфигу),
а не роняют весь запрос — как `securityDetail` сейчас.

`applyAnswersToConfig`:

- `configureProvider === false` — пропустить провайдера, модель, контекст и
  `maxToolIterations`;
- `contextAuto === true` — писать `contextAuto = true` и **не** сбрасывать его
  в `false` при совпадении/различии `contextWindow`;
- `contextAuto === false` — текущее поведение (`contextAuto = false` при
  выбранном вручную окне);
- `criticEnabled !== undefined` → `config.critic.enabled`;
- `webSearchEnabled !== undefined` → `config.webSearch.enabled`;
- `theme/themeMode/themeEffects` → `config.ui.*`;
- `sounds` → `config.ui.sounds.*` (частичное слияние);
- `soundsEnabled` остаётся поддержанным как алиас для `sounds.enabled`.

### 5.3. `POST /api/setup/test`

Ответ расширяется, обратная совместимость сохраняется:

```json
{ "ok": true, "latencyMs": 412, "replyChars": 18 }
```

Проба остаётся дешёвой (`probeChat`, `SETUP_CHAT_TIMEOUT_MS`), проходит через
тот же rate-limit и SSRF-гард, что `models/context`.

### 5.4. Черновик визарда

`localStorage["mma-setup-draft-v1"]`:

```jsonc
{ "v": 1, "step": 3, "answers": { /* всё, кроме apiKey */ } }
```

- Пишется при каждом переходе/изменении ответа.
- Восстанавливается в `maybeOpen()`: `step` зажимается в диапазон, ответы
  мержатся поверх дефолтов.
- `apiKey` никогда не сохраняется.
- Удаляется после успешного `POST /api/setup` и когда `required = false`.

### 5.5. Безопасность шага 3.4

Три тумблера остаются. Над ними добавляются пресеты, которые только
выставляют существующие флаги:

| Пресет | paths | bash | flags |
|---|---|---|---|
| Осторожный | on | on | on |
| Обычный (дефолт) | on | off | off |
| Доверенный | off | off | off |

Пресет — UI-сахар, в конфиг едет как три булевых поля, отдельного ключа нет.

## 6. UX-детали

- Слайд 1: язык сверху (сегмент), ниже — только текст знакомства, без
  чек-листа «понадобится» и без описания шагов. CTA «Начать», без «Назад».
- Слайд 2.4: переключатель `Авто / Вручную`; «Авто» вызывает
  `POST /api/setup/context` при входе и после смены модели; неудача — жёлтое
  сообщение и переход в ручной режим.
- Слайд 3.3: 12 скинов из `UI_THEMES`, режим `Тёмная/Светлая/Авто`, тумблер
  эффектов; звуки — мастер, три события, громкость, кнопка «Прослушать».
  Тема применяется сразу (класс на `body` + `localStorage`), в конфиг пишется
  на финальном POST.
- Слайд 4.0: сводка + «Проверить и запустить» (реальный короткий запрос,
  задержка) + путь workspace (read-only) + версия.
- Доступность: после рендера фокус на `h2` шага (`tabindex="-1"`),
  `aria-current="step"` на полосе, `aria-live="polite"` на сообщениях,
  `Esc` закрывает попап безопасности.

## 7. Security

- `apiKey` принимается, но не возвращается и не попадает в черновик.
- Черновик не содержит секретов; при `required = false` удаляется.
- Пробы (`models/test/context`) сохраняют rate-limit и SSRF-политику
  (`setup-policy.ts`), новых сетевых путей нет.
- `POST /api/setup` по-прежнему отвечает `409 already_configured` после
  завершения и `503` без конфига.
- Запись конфига — единый путь `applyAnswersToConfig` + `persistAndReconfigure`.

## 8. Tests

- `tests/webui-setup.test.ts`: `configureProvider=false` без provider/model;
  новые поля; `contextAuto`; отказ невалидной темы/режима/звуков.
- `tests/modules/setup/apply.test.ts`: пропуск провайдера; critic/webSearch/ui;
  `contextAuto` не сбрасывается.
- `tests/webui-setup-intro-dom.test.ts`: welcome без чек-листа, язык сверху,
  CTA «Начать», нет «Назад».
- Новый `tests/webui-setup-steps-dom.test.ts`: 2.0, 2.4 auto/manual, 3.1/3.2,
  3.3, пресеты 3.4.
- `tests/webui-setup-draft.test.ts`: сохранение/восстановление без `apiKey`.
- `tests/i18n.test.ts`: симметрия новых ключей.
- API-тест `/api/setup/test` с `latencyMs`.

## 9. Follow-ups

- `mma web --setup` и кнопка «Пройти настройку заново».
- Стартовая карточка с 3–4 запросами в пустом чате после настройки.
- Импорт ключей из окружения (`OPENAI_API_KEY`, …) и ссылки «где взять ключ».
