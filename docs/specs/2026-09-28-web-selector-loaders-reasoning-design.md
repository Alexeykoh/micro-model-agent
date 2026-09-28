# Web-селекторы: лоадеры переключения + 4-й селектор reasoning

> **Дата:** 2026-09-28
> **Статус:** черновик спеки (на ревью)
> **Область:** `mma web` — композер (provider / model / context) + новый селектор reasoning
> **Связанные доки:** [dynamic-reasoning-control](./2026-08-25-dynamic-reasoning-control.ru.md), [STYLE](../../design/ui/STYLE.md), [webui-provider-settings](./2026-09-25-webui-provider-settings-design.md)

## 1. Проблема

При переключении модели / провайдера / контекста в веб-композере нет состояния загрузки:

1. `postConfig()` (`assets/js/settings.js:156`) делает `POST /api/config` → `persistAndReconfigure`
   (сервер: `agent.reconfigure` + `modelCache.refresh`, `module.ts:113`) → клиент затем
   последовательно `await loadConfig()` + `await loadModels()` и только потом `renderSelectors()`.
2. Всё это время кнопки селекторов показывают **старые** значения, меню уже закрыто,
   повторный клик возможен, список моделей может быть от **старого** провайдера
   (refresh асинхронный, офлайн-провайдер вообще оставляет прошлый список — `model-cache.ts:33`).
3. Ощущение бага/зависания: клик «съеден», ничего не происходит 0.5–3с (холодный `listModels`,
   `reconfigure`), потом значения «прыгают» сразу в нескольких местах (топбар, панель Model,
   usage-лимит через SSE `state` + 2с-поллинг `refresh()` в `app.js:278`).
4. Boot (`app.js:243 boot()`) — та же болезнь: селекторы показывают `—` без скелетона,
   пока идут `loadConfig → loadModels → loadProviders → refresh`.
5. Рядом с тремя селекторами нет переключателя глубины reasoning (`reasoning.mode`,
   уже `reconfigure:true`, `registry.ts:192`), хотя это та же ось «на чём и как думаем».
   Юзер вынужден идти в Settings → Reasoning, не видя, поддерживает ли модель уровни вообще.

## 2. Цели / не-цели

**Цели:**
- Явное pending-состояние каждого селектора от клика до **полной** готовности
  (конфиг применён + модели/провайдеры перезагружены + селекторы перерисованы).
- Защита от дабл-клика и гонок (быстрые A→B→A), честная ошибка с откатом подписи.
- 4-й селектор `reasoning` в том же ряду, показывающий **только поддерживаемые уровни**.
- STYLE.md: строки/глифы, без boxed-панелей; quiet по умолчанию.

**Не-цели:**
- Не меняем сам `reconfigure`/`modelCache`, не трогаем терминальный REPL.
- Не делаем оптимистичную отправку сообщений на новом конфиге (порядок прежний:
  сначала конфиг готов, потом чат).
- Не добавляем авто-probe reasoning в веб (переиспользуем существующий кэш `probe.ts`).

## 3. Текущий поток (факт)

```
клик меню → postConfig(key, value, refreshSettings)
  → POST /api/config → setConfigValue → persistAndReconfigure
      → agent.reconfigure + modelCache.refresh → broadcast SSE state(usage)
  → await loadConfig() → await loadModels()   // последовательно, без индикации
  → renderSelectors() + [renderSettings()]
```

SSE `state` после reconfigure уже несёт свежий `usage.contextLimit`, а `renderState`
(`app.js:58`) дотягивает `contextWindow` из снапшота без `loadConfig` — этот паттерн
переиспользуем как сигнал «готово».

## 4. Дизайн: лоадеры селекторов

### 4.1 Состояния кнопки

- `data-pending="provider|model|context|reasoning"` на `.selectors` + класс `.pending`
  на активной кнопке: подпись `…` (ellipsis, без новых спиннер-гифок — в чате уже есть
  `.busy .spin`, используем текстовый `⋯`, как `connStatus`), `aria-busy="true"`,
  `aria-disabled="true"`, клики по **всем трём-четырём** меню блокируются до конца операции.
- Пункты меню: выбранный пункт получает суффикс `⋯`, остальные — `disabled`.
  Меню **не закрывается** до успеха/ошибки? Решение: закрывать сразу (как сейчас),
  pending виден на кнопке — иначе меню перекрывает композер на 2–3с. Пункт «custom…»
  у контекста блокируется вместе с остальными.
- Boot-скелетон: пока `S.state.config === null` кнопки показывают `⋯` + `aria-busy`,
  клики игнорятся (сейчас — `—` и рабочее меню в пустоту).

### 4.2 Single-flight + stale-guard

- Монотонный `switchSeq` в `settings.js`: каждый `postConfig` захватывает `seq`,
  по завершении рендерит только если `seq === latestSeq`. Поздний ответ A→B→A
  не перетирает свежий.
- Пока `pending` — новые `postConfig` из селекторов отклоняются с тостом
  `web.selectors.switch_busy` («дождитесь окончания переключения»), очередь не копим.
  Исключение: boot-загрузки (`loadConfig/loadModels` без юзер-клика) pending не ставят.

### 4.3 Определение «полностью загружено»

Операция считается завершённой, когда выполнены **все**:
1. `POST /api/config` → `200 {ok:true}` (иначе — ошибка, п.4.4);
2. `await loadConfig()` + `await loadModels()` (для `provider.active`/`model`;
   для `contextWindow`/`reasoning.mode` достаточно `loadConfig`, модели не трогаем —
   сейчас код грузит модели и для контекста, это лишний RTT — убрать);
3. `renderSelectors()` (+ `renderSettings()`, если панель открыта и ключ влияет).
Параллелить: `Promise.all([loadConfig(), loadModels()])` вместо последовательных await
(независимые GET). SSE `state` остаётся дополнительным живым апдейтом usage, не гейтом.

Таймаут: 15с на всю операцию (холодный `listModels` у Zen/Go). Превышение → ошибка
с сохранением старого значения (сервер уже мог применить конфиг — см. 4.4).

### 4.4 Ошибки и откат

- `400 invalid-value` (невалидный контекст/имя): кнопка возвращается к старому значению,
  красный тост `setIndicator(err, true)` (существующий механизм), pending снимается.
- Сетевой сбой / `503` / таймаут после **успешного** POST: конфиг на сервере мог смениться,
  а клиент не знает итог → принудительный `await loadConfig()` + `renderSelectors()`
  (показать правду сервера), тост `web.selectors.switch_failed` + `↻` в меню моделей
  остаётся путём восстановления.
- Оптимистичную подпись **не ставим заранее** (кнопка показывает старое значение + `⋯`) —
  так не нужен откат в частом кейсе, а «прыжок» исчезает: подпись меняется один раз
  вместе со снятием pending.

### 4.5 CSS (STYLE.md)

- Никаких рамок/боксов: `.sel > button.pending b { color: var(--dim-b); }` +
  `⋯` в подписи; `@media (prefers-reduced-motion: reduce)` — без анимаций
  (мигание ellipsis выключено, статичное `…`).
- Светлая/тёмная темы — только существующие токены (`--dim-b`, `--purple`).

## 5. Дизайн: 4-й селектор reasoning

### 5.1 Источник правды о поддержке

Клиенту нужен ответ «что умеет активная связка провайдер+модель». Предложение —
расширить `GET /api/models` (без новых роутов):

```json
GET /api/models →
{
  "models": ["qwen3:8b", "..."],
  "reasoning": { "strategy": "openai-effort|prompt-tag|template-kwarg|none",
                 "supported": true|false|null, "mode": "auto" }
}
```

- `strategy` — из пресета активного провайдера (`BUILTIN_PROVIDERS[].capabilities.reasoningStrategy`).
- `supported` — результат кэша `getCachedProbeResult(baseUrl|model)` (`probe.ts`):
  `true` — механизм подтверждён, `false` — игнор, `null/undefined` — probe ещё не бегал
  (показываем полные уровни, но с пометкой «уточняется»; после первого хода бэкенд
  доподтвердит фоном как сейчас).
- `mode` — текущий `config.reasoning.mode` (переиспользуем, отдельный GET не нужен).
- Альтернатива (хуже): новый `GET /api/reasoning` — лишний RTT на каждое переключение;
  отклонено.

Серверная работа: пробросить `strategy` + `probeResult` в `WebUiState`
(`state.ts`, `module.ts:makeReconfigure` обновляет при смене провайдера/модели).
Поле аддитивно, старые клиенты игнорируют → MINOR.

### 5.2 Какие уровни показывать

Базовое множество (`ReasoningMode`): `auto · default · none · low · medium · high · max`.
Правила фильтрации (маппинг из спеки dynamic-reasoning-control §3/§5):

| strategy | probe | пункты меню |
|---|---|---|
| `none` | — | селектор **скрыт** (`hidden`), в Settings остаётся |
| любое, probe `false` | — | селектор disabled, подпись `off`, тултип `reasoning.probe_failed`; клик ведёт в Settings → Reasoning |
| `openai-effort` | `true/null` | все 7: `auto/default/none/low/medium/high/max` |
| `prompt-tag` / `template-kwarg` | `true/null` | `auto/default/none/low/high` (`medium/max` схлопываются в `low/high`, §3 — показываем схлопнутое множество, без дублей; `max` скрыт) |

Подпись кнопки: короткий уровень (`auto/low/high/…`), активный пункт — `✓` + `current`.
Пост — тем же `postConfig("reasoning.mode", lvl, false)` (уже `reconfigure:true`,
модели не перезагружаем, п.4.3). Значения `min/max/baseline` остаются в Settings.

### 5.3 Размещение и порядок

Ряд `.selectors`: `provider · model · context · reasoning` (reasoning последний —
реже меняется). На узких экранах переносится как остальные (`flex-wrap` уже есть).
`data-sel="reasoning"`, меню вверх (`bottom: calc(100% + 4px)`, как у соседей).

## 6. i18n (en+ru, ключи)

```
web.selectors.reasoning   — reasoning / рассуждения
web.selectors.switching   — switching… / переключение…
web.selectors.switch_busy — switch in progress, please wait / переключение уже идёт, подождите
web.selectors.switch_failed — switch failed, reloaded server state / не переключилось, показано состояние сервера
web.selectors.reasoning_off — off (probe failed) / выкл (бэкенд не поддерживает)
web.selectors.loading     — loading… / загрузка…
```

Плюрализация не нужна. Хром-локализация через существующий `GET /api/i18n`.

## 7. Тесты

- Юнит (`tests/webui-*.test.ts`): stale-guard (A→B→A — рендерит только B);
  `contextWindow` не тянет `loadModels`; фильтр уровней по strategy×probe (таблица 5.2);
  `strategy:none` → селектор скрыт.
- E2E (`tests/e2e/web-selectors*.ts`, по явной команде `bun run test:e2e`):
  переключение provider → кнопка `pending` + `aria-busy`, дабл-клик отклонён,
  после готовности подпись = серверный конфиг; офлайн-провайдер → список не пуст,
  тост показан; reasoning-меню содержит только поддерживаемые уровни.
- Ручной чек: холодный Zen/Go (долгий listModels), LM Studio offline, узкий вьюпорт 360px,
  `prefers-reduced-motion`, светлая тема.

## 8. Роллаут

1. Бэкенд: `reasoning` в `GET /api/models` + `WebUiState` (+ тесты).
2. Фронт: pending/single-flight/параллельные GET (без reasoning).
3. Фронт: 4-й селектор + фильтрация + i18n.
4. E2E + CHANGELOG (MINOR: новый селектор + аддитивное поле API).
