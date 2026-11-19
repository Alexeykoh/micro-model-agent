# Инвентарь настроек MMA 0.26.0 и браузерный прогон

Документ фиксирует полный реестр конфигурационных ключей MMA `v0_26_0` и результаты проверки каждого ключа через реальные контролы веб-панели настроек в Playwright.

- Версия: `0.26.0` (ветка `docs/settings-inventory`, ворктри от тега `v0_26_0`).
- Стенд: Docker `mma-web-test`, UI `http://127.0.0.1:7334/?token=docker-test-hamachi-2026`.
- Модель для живых прогонов: провайдер `llama.cpp`, модель `deepseek-v4-pro-9b` (задана как базовая).
- Дата прогона: 2026-11-19.

## Итоги

| Статус | Количество |
| --- | ---: |
| OK | 196 |
| SKIP | 1 |
| N/A | 2 |
| OK (read-only) | 1 |
| **Всего** | **200** |

**OK** — значение изменено через UI-контрол, прочитано обратно через `GET /api/config` и совпало с ожидаемым; исходное значение восстановлено. **OK (read-only)** — проверено отображение значения. **SKIP/N/A** — контрол недоступен на стенде (см. ограничения).

## Методика

1. Полный список ключей взят из `src/config/registry.ts` (дефы `AGENT_DEFS`, `META_DEFS`, `SECURITY_DEFS`, `EXTRA_DEFS`) — 199 канонических ключей. Ещё один ключ (`execution.autoAdvance`) присутствует в реестре, который отдаёт `GET /api/config` на стенде; он добавлен в инвентарь и тоже проверен. Значения по умолчанию сняты с `DEFAULTS` через `def.get()`.
2. Для каждого ключа по словарю `config.key.<key>` (`GET /api/i18n`) находилась строка в DOM: `[data-panel="..."] .row` с `.row-name`. Метки уникальны в пределах панели, что даёт однозначное соответствие ключ → контрол.
3. Значение менялось реальным UI-событием: клик по `role=switch`, `change` на `select`/`input`, Enter/клик в редакторах тегов, таблиц и чекбоксов, кнопки `+`/`-` громкости. Специфичные редакторы: `tagsEditor`, `checkboxEditor`, `tableEditor`, `jsonctl`, `theme-picker`, селекторы модели/провайдера.
4. Результат сверялся с `GET /api/config`; затем исходное значение восстанавливалось через `POST /api/config` (для секретов — через проверку ответа POST, т.к. GET маскирует значения).
5. Стенд после прогона приведён к исходному состоянию: все `probe-*`-значения удалены, модель/провайдер — `llama.cpp / deepseek-v4-pro-9b`, `contextAuto=true`, `ui.theme=console`, `memory.validator.enabled=true`.

## Ограничения и наблюдения

- `provider.active` — на стенде доступен только один провайдер (`llama.cpp`), поэтому переключение через селектор невозможно; сам контрол и меню присутствуют и отображают активное значение. Полноценная проверка требует второго провайдера.
- `ui.themeEffects` — в этой сборке нет контрола в панели настроек; ключ доступен только через API/CLI. В DOM нет строки с меткой `эффекты темы`.
- `security.contentScan.dangerousPatterns` — ключ есть в реестре, но в DOM стенда нет соответствующей строки/секции, поэтому проверить его через UI невозможно. Аналогично в `PANEL_SECTIONS` упомянуты `hitl.*` и `compliance.*`, для которых нет ни def реестра, ни строк в DOM.
- Секретные ключи (`webSearch.apiKey`, `service.token`, `security.auditNotifier.webhookUrl`) маскируются в `GET /api/config` как `***`; их запись проверялась по ответу `POST /api/config` и по значению в поле ввода.
- `contextAuto` при выключении запускает пробу провайдера: ответ конфига приходит не сразу, а примерно через 1–2 c. Проверка с коротким ожиданием давала ложный `FAIL`; с ожиданием 1.8 c ключ работает.
- Табличные редакторы `pricing.overrides` и `modelCapabilities` не отправляют новую строку, пока не заполнено хотя бы одно обязательное/непустое поле (`input`/`output` для цен, любой чекбокс для возможностей). Это ожидаемое поведение редактора, не дефект.
- В консоли браузера при прогоне было 43 ответа `400` на `POST /api/config` — они вызваны попытками тестового раннера восстановить unset-ключи пустой строкой (`allowEmpty=false`). Это артефакт методики, а не ошибка приложения; после корректного восстановления стенд чист.

## Полный инвентарь

Колонка «По умолчанию» — значение из `DEFAULTS` (для `version` — версия приложения из реестра). `Эффекты` — объявленные в реестре последствия записи (INV-18).

### Общие — 13

| Ключ | Метка (RU) | Тип | По умолчанию | Алиасы | Эффекты | Тест | Примечание |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ui.verbosity` | подробность | enum | `quiet` | verbosity |  | OK |  |
| `maxToolIterations` | макс. итераций тулов | int | `200` |  |  | OK |  |
| `stuckThreshold` | порог застревания | int | `6` |  |  | OK |  |
| `locale` | язык | enum | `en` |  | i18n.reload | OK |  |
| `execution.profile` | профиль исполнения | enum | `local-trusted` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `execution.image` | образ песочницы | string | `oven/bun:1.3.14` |  |  | OK |  |
| `cost.maxRunUsd` | бюджет хода, USD | int | `5` |  |  | OK |  |
| `autoPlan` | автоплан | bool | `true` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `promptProfile` | профиль промпта | enum | `auto` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `updater.enabled` | автообновление | bool | `true` |  |  | OK |  |
| `updater.autoInstall` | автоустановка обновлений | bool | `false` |  |  | OK |  |
| `updater.intervalMs` | интервал проверки (мс) | int | `0` |  |  | OK |  |
| `execution.autoAdvance` | execution.autoAdvance | bool | `true` |  |  | OK |  |

### Модель и провайдер — 7

| Ключ | Метка (RU) | Тип | По умолчанию | Алиасы | Эффекты | Тест | Примечание |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `provider.fallback` | резервные провайдеры | bool | `false` |  |  | OK |  |
| `provider.maxCompletionTokens` | макс. токенов ответа по умолчанию | int | `8192` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `modelLoad.autoLoad` | автозагрузка модели | bool | `false` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `modelLoad.flashAttention` | flash attention | bool | `true` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `modelLoad.offloadKvCacheToGpu` | выгружать KV-кэш в GPU | bool | `true` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `modelLoad.evalBatchSize` | размер eval-батча | int | `512` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `modelCapabilities` | возможности моделей | json | `{}` |  |  | OK | добавлена строка + отмечен чекбокс в таблице |

### Контекст — 22

| Ключ | Метка (RU) | Тип | По умолчанию | Алиасы | Эффекты | Тест | Примечание |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `contextWindow` | окно контекста | int | `32768` | context.window | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `contextBudget.systemPrompt` | доля системного промпта | share | `0.1` | context.system | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `contextBudget.responseReserve` | резерв ответа | share | `0.15` | context.reserve | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `contextAuto` | авто-определение окна контекста | bool | `true` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK | тумблер + ожидание 1.8 c (автопроба провайдера) |
| `contextBudget.compactionThreshold` | порог компакции | share | `0.75` |  |  | OK |  |
| `contextBudget.compactionMinLoad` | мин. загрузка компакции | share | `0.5` |  |  | OK |  |
| `contextBudget.policy` | политика компакции | enum | `v2` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `contextBudget.compactionSummary` | сводка компакции | enum | `ledger` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `contextBudget.overflowCooldown` | cooldown переполнения | int | `3` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `contextBudget.toolResultKeep` | оставлять свежие tool-результаты | int | `6` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `contextBudget.toolDigest` | дайджест вывода тулов | enum | `full` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `contextBudget.admitMaxTokens` | порог admission | int | `3000` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `contextBudget.notesPath` | путь к леджеру адресов | string | `.mma/NOTES.md` |  |  | OK |  |
| `contextBudget.ledgerMax` | ёмкость леджера | int | `200` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `contextBudget.calibrationWarmup` | прогрев калибровки | int | `3` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `contextBudget.ratioFloor` | нижний порог калибровки | share | `0.5` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `instructions.summarize` | суммировать инструкции | bool | `true` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `contextLog.enabled` | лог контекста | bool | `false` |  |  | OK |  |
| `contextLog.redact` | чистить лог контекста | bool | `true` |  |  | OK |  |
| `indexer.maxFiles` | лимит файлов индекса | int | `5000` |  |  | OK |  |
| `indexer.respectGitignore` | учитывать .gitignore | bool | `true` |  |  | OK |  |
| `indexer.mapTokenBudget` | бюджет токенов карты | int | `1500` |  |  | OK |  |

### Рассуждения — 6

| Ключ | Метка (RU) | Тип | По умолчанию | Алиасы | Эффекты | Тест | Примечание |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `showReasoning` | показывать рассуждения | bool | `true` | reasoning.show |  | OK |  |
| `reasoning.mode` | режим рассуждений | enum | `auto` | reasoning.level | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `reasoning.min` | мин. рассуждения | enum | `low` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `reasoning.max` | макс. рассуждения | enum | `high` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `reasoning.baseline` | базовые рассуждения | enum | `low` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `reasoning.overrideCooldown` | кулдаун переопределения | int | `5` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |

### Память — 5

| Ключ | Метка (RU) | Тип | По умолчанию | Алиасы | Эффекты | Тест | Примечание |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `memory.validator` | гейт качества памяти | bool | `true` |  |  | OK | тумблер меняет вложенный флаг enabled |
| `memory.validator.minChars` | память: мин. символов | int | `15` |  |  | OK |  |
| `memory.validator.minWords` | память: мин. слов | int | `3` |  |  | OK |  |
| `memory.validator.similarityThreshold` | память: порог дубликата | share | `0.8` |  |  | OK |  |
| `memory.retentionDays` | память: хранение (дней) | int | `0` |  |  | OK |  |

### Агент — 20

| Ключ | Метка (RU) | Тип | По умолчанию | Алиасы | Эффекты | Тест | Примечание |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `critic.enabled` | проверяющий (критик) | bool | `true` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `critic.maxCalls` | макс. вызовов критика | int | `4` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `critic.maxRepairCycles` | циклы исправления критика | int | `1` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `critic.timeoutMs` | таймаут критика (мс) | int | `125000` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `critic.model` | модель критика | string | `` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `critic.tools` | проверки критика | bool | `true` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `critic.provider` | провайдер критика | string | `` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `critic.maxTokens` | бюджет токенов критика | int | `2048` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `tools.enableOnDemand` | тулы по требованию | bool | `true` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `tools.grepEngine` | движок grep | enum | `auto` |  |  | OK |  |
| `skills.budget` | доля бюджета скиллов | share | `0.15` |  |  | OK |  |
| `hallucination.judge.enabled` | судья галлюцинаций | bool | `false` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `subagent.resultMode` | режим результата субагентов | enum | `text` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `subagent.maxSummaryChars` | лимит сводки субагента | int | `2000` |  |  | OK |  |
| `subagent.maxParallelChunkQueries` | параллельные чанки субагента | int | `4` |  |  | OK |  |
| `subagent.timeoutMs` | idle-таймаут субагента (мс) | int | `180000` |  |  | OK |  |
| `subagent.maxDurationMs` | макс. длительность субагента (мс) | int | `1800000` |  |  | OK |  |
| `subagent.stableSystemPrompt` | стабильный промпт субагента | bool | `true` |  |  | OK |  |
| `tools.defaultTags` | теги тулов по умолчанию | list | `["file","code"]` |  |  | OK |  |
| `experts` | Experts | json | `{"code":{"tool_tags":["file","code","shell"],"max_attempts":3,"description":"file opera…` |  |  | OK |  |

### Сеть — 12

| Ключ | Метка (RU) | Тип | По умолчанию | Алиасы | Эффекты | Тест | Примечание |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `webSearch.enabled` | веб-поиск | bool | `true` |  |  | OK |  |
| `webSearch.provider` | провайдер поиска | enum | `duckduckgo` |  |  | OK |  |
| `webSearch.apiKey` | API-ключ провайдера поиска | string | `` |  |  | OK | POST ok=true, UI сохраняет введённое значение |
| `webSearch.baseUrl` | адрес SearXNG | string | `` |  |  | OK |  |
| `webSearch.images` | картинки из поиска | bool | `false` |  |  | OK |  |
| `webSearch.maxImages` | картинок на запрос | int | `2` |  |  | OK |  |
| `errorWebSearch.enabled` | поиск при ошибке | bool | `true` |  |  | OK |  |
| `errorWebSearch.threshold` | порог поиска ошибок | int | `5` |  |  | OK |  |
| `errorWebSearch.maxResults` | результатов поиска ошибок | int | `5` |  |  | OK |  |
| `errorWebSearch.maxQueryChars` | лимит запроса ошибки | int | `200` |  |  | OK |  |
| `errorWebSearch.maxSearchesPerSession` | поисков ошибок за сессию | int | `3` |  |  | OK |  |
| `errorWebSearch.requestTimeoutMs` | таймаут поиска ошибок (мс) | int | `10000` |  |  | OK |  |

### Сервис — 15

| Ключ | Метка (RU) | Тип | По умолчанию | Алиасы | Эффекты | Тест | Примечание |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `service.port` | порт сервиса | int | `7331` |  |  | OK |  |
| `service.host` | адрес привязки сервиса | string | `127.0.0.1` |  |  | OK |  |
| `service.token` | bearer-токен сервиса | string | `` |  |  | OK | POST ok=true, UI сохраняет введённое значение |
| `service.tenant` | тенант сервиса | string | `` |  |  | OK |  |
| `service.resultRetentionDays` | хранение результатов (дни) | int | `7` |  |  | OK |  |
| `service.idempotencyTtlHours` | TTL идемпотентности (часы) | int | `24` |  |  | OK |  |
| `service.syncWaitMs` | кап синхронного ожидания (мс) | int | `10000` |  |  | OK |  |
| `service.maxQueueLength` | макс. задач в очереди сессии | int | `5` |  |  | OK |  |
| `service.detachedTurnGraceMs` | окно отвязки хода (мс) | int | `0` |  |  | OK |  |
| `service.callbackTimeoutMs` | таймаут webhook (мс) | int | `10000` |  |  | OK |  |
| `service.webhookSecret` | секрет HMAC webhook | string | `` |  |  | OK |  |
| `service.webhookAllowHttp` | разрешить http webhook на loopback | bool | `false` |  |  | OK |  |
| `service.tls.cert` | TLS-сертификат (путь к PEM) | string | `` |  |  | OK |  |
| `service.tls.key` | TLS-ключ (путь к PEM) | string | `` |  |  | OK |  |
| `service.tls.terminatedByProxy` | TLS терминирует прокси | bool | `false` |  |  | OK |  |

### Браузер — 9

| Ключ | Метка (RU) | Тип | По умолчанию | Алиасы | Эффекты | Тест | Примечание |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `browser.enabled` | тул браузера | bool | `true` |  |  | OK |  |
| `browser.headless` | безголовый браузер | bool | `true` |  |  | OK |  |
| `browser.maxElements` | макс. элементов страницы | int | `30` |  |  | OK |  |
| `browser.maxContentChars` | макс. содержимого страницы | int | `2500` |  |  | OK |  |
| `browser.maxConsoleEntries` | макс. записей консоли | int | `40` |  |  | OK |  |
| `browser.maxConsoleLineChars` | макс. строки консоли | int | `400` |  |  | OK |  |
| `browser.viewportWidth` | ширина вьюпорта | int | `1280` |  |  | OK |  |
| `browser.viewportHeight` | высота вьюпорта | int | `720` |  |  | OK |  |
| `browser.navigationTimeout` | таймаут навигации (мс) | int | `15000` |  |  | OK |  |

### Сессии — 6

| Ключ | Метка (RU) | Тип | По умолчанию | Алиасы | Эффекты | Тест | Примечание |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `session.autoSave` | автосохранение сессии | bool | `true` |  |  | OK |  |
| `session.maxSessions` | макс. сессий | int | `50` |  |  | OK |  |
| `session.isolateMemory` | изолировать память сессии | bool | `false` |  |  | OK |  |
| `session.autoName` | автоназвания сессий | bool | `true` |  |  | OK |  |
| `sessionIsolation.enabled` | изоляция сессий | bool | `false` |  |  | OK |  |
| `sessionIsolation.isolateTempFiles` | изолировать временные файлы | bool | `true` |  |  | OK |  |

### Интерфейс и тема — 13

| Ключ | Метка (RU) | Тип | По умолчанию | Алиасы | Эффекты | Тест | Примечание |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ui.sounds.enabled` | звуки | bool | `true` |  |  | OK |  |
| `ui.sounds.done` | звук: ход завершён | bool | `true` |  |  | OK |  |
| `ui.sounds.question` | звук: ждёт ответа | bool | `true` |  |  | OK |  |
| `ui.sounds.failed` | звук: ход упал | bool | `true` |  |  | OK |  |
| `ui.sounds.volume` | громкость звука | int | `50` |  |  | OK |  |
| `ui.spinner` | спиннер | bool | `true` |  |  | OK |  |
| `ui.activityRail` | рейка активности | enum | `line` |  |  | OK |  |
| `ui.showContextStats` | статистика контекста | bool | `false` |  |  | OK |  |
| `ui.showCompaction` | уведомление о компакции | bool | `true` |  |  | OK |  |
| `ui.fontSize` | размер шрифта | enum | `comfortable` |  |  | OK |  |
| `ui.draftMode` | показ черновика | enum | `live` |  |  | OK |  |
| `images.maxCount` | хранимых изображений | int | `30` |  |  | OK |  |
| `images.maxBytes` | лимит размера изображений | int | `104857600` |  |  | OK |  |

### Плагины · MCP — 4

| Ключ | Метка (RU) | Тип | По умолчанию | Алиасы | Эффекты | Тест | Примечание |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `plugins.maxDrafts` | лимит черновиков capabilities | int | `10` |  |  | OK |  |
| `lsp.enabled` | LSP | bool | `true` |  |  | OK |  |
| `lsp.offline` | офлайн-режим LSP | bool | `false` |  |  | OK |  |
| `lsp.typescriptEngine` | движок TypeScript | enum | `typescript-language-server` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |

### Безопасность — 50

| Ключ | Метка (RU) | Тип | По умолчанию | Алиасы | Эффекты | Тест | Примечание |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `security.enabled` | безопасность | bool | `true` |  |  | OK |  |
| `security.bash.enabled` | проверка bash-команд | bool | `true` |  |  | OK |  |
| `security.bash.blockDangerousFlags` | блокировать опасные флаги | bool | `true` |  |  | OK |  |
| `security.paths.enabled` | ограничить пути файлов | bool | `false` |  |  | OK |  |
| `security.contentScan.enabled` | сканировать содержимое файлов | bool | `false` |  |  | OK |  |
| `security.sessionEncryption.enabled` | шифровать файлы сессий | bool | `false` |  |  | OK |  |
| `security.network.enabled` | сетевые запросы | bool | `true` |  |  | OK |  |
| `security.dataPolicy.enabled` | политика данных | bool | `true` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `security.dataPolicy.trustLocalClients` | доверять локальным клиентам | bool | `true` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `security.dataPolicy.pathMode` | режим путей | enum | `prefix` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `security.dataPolicy.pseudonymize` | псевдонимизация | bool | `true` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `security.dataPolicy.egress.paths` | скрывать пути у провайдера | bool | `true` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `security.dataPolicy.egress.machine` | скрывать имя машины | bool | `true` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `security.dataPolicy.egress.env` | скрывать окружение | bool | `true` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `security.dataPolicy.egress.pii` | маскировать PII | bool | `true` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `security.dataPolicy.egress.fileContent` | блокировать содержимое файлов | bool | `true` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `security.dataPolicy.egress.secrets` | маскировать секреты | bool | `true` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `security.dataPolicy.allowImagesToExternal` | изображения наружу | bool | `false` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `security.dataPolicy.failClosed` | fail-closed | bool | `true` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `security.dataPolicy.minConfidence` | мин. уверенность | share | `0.4` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `security.dataPolicy.trustedHosts` | доверенные хосты | list | `[]` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `security.dataPolicy.apiHiddenGlobs` | скрыто от API | list | `[]` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `security.dataPolicy.providerBlockGlobs` | блок наружу | list | `[]` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `security.maxRecursionDepth` | макс. глубина рекурсии | int | `3` |  |  | OK |  |
| `security.maxFileOperations` | макс. файловых операций | int | `100` |  |  | OK |  |
| `security.rateLimits.maxRequestsPerMinute` | макс. запросов в минуту | int | `60` |  |  | OK |  |
| `security.rateLimits.maxParallelTasks` | макс. параллельных задач | int | `5` |  |  | OK |  |
| `security.bash.blacklist` | черный список bash | list | `["rm","dd","chmod","wget","curl","scp","ssh","nc","netcat","mknod","mkfifo","ln","chown…` |  |  | OK |  |
| `security.bash.whitelist` | белый список bash | list | `[]` |  |  | OK |  |
| `security.bash.dangerousFlags` | опасные флаги | list | `["--force","-rf","--no-preserve-root","--recursive","--all","-x","-e","--delete","--rem…` |  |  | OK |  |
| `security.bash.dangerousOperators` | опасные операторы | list | `[">",">>","2>","2>>",";","&&","\|\|","\|","'","$("]` |  |  | OK |  |
| `security.paths.denied` | запрещенные пути | list | `[".git/","node_modules/",".env","*.key","*.pem","*.crt","*.p12","*.pfx","*.secret","*.t…` |  |  | OK |  |
| `security.paths.allowed` | разрешенные пути | list | `[]` |  |  | OK |  |
| `security.network.deniedDomains` | запрещенные домены | list | `["localhost","127.0.0.1","::1"]` |  |  | OK |  |
| `security.network.allowedDomains` | разрешенные домены | list | `[]` |  |  | OK |  |
| `security.network.requestTimeout` | сетевой таймаут (мс) | int | `15000` |  |  | OK |  |
| `security.network.maxResponseSize` | макс. размер ответа | int | `15000` |  |  | OK |  |
| `security.network.allowPrivateOutbound` | приватные callback-адреса | bool | `false` |  |  | OK |  |
| `security.network.allowLoopback` | loopback-доступ веб-тулов | bool | `false` |  |  | OK |  |
| `security.contentScan.dangerousPatterns` | опасные паттерны | json | `["eval\\(","new Function\\(","child_process\\.exec\\(","child_process\\.spawn\\(","requ…` |  |  | N/A | на стенде строка/секция не отрисована (нет контрола в панели) |
| `security.auditNotifier.enabled` | аудит-уведомитель | bool | `false` |  |  | OK |  |
| `security.auditNotifier.filePath` | путь аудит-лога | string | `` |  |  | OK |  |
| `security.auditNotifier.webhookUrl` | URL аудит-вебхука | string | `` |  |  | OK | POST ok=true, UI сохраняет введённое значение |
| `security.auditNotifier.webhookTimeout` | таймаут аудит-вебхука (мс) | int | `5000` |  |  | OK |  |
| `security.auditNotifier.minSeverity` | мин. серьезность аудита | enum | `medium` |  |  | OK |  |
| `security.auditNotifier.eventTypes` | типы событий аудита | json | `["security_block","bash_command","file_operation","network_request"]` |  |  | OK |  |
| `security.auditNotifier.maxRetries` | макс. повторов аудита | int | `3` |  |  | OK |  |
| `security.sessionEncryption.keyPath` | путь ключа шифрования | string | `` |  |  | OK |  |
| `security.sessionEncryption.encryptHistory` | шифровать историю чата | bool | `true` |  |  | OK |  |
| `security.sessionEncryption.encryptSessionLog` | шифровать лог сессии | bool | `true` |  |  | OK |  |

### Дополнительно — 12

| Ключ | Метка (RU) | Тип | По умолчанию | Алиасы | Эффекты | Тест | Примечание |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `logLevel` | уровень логов | enum | `info` |  |  | OK |  |
| `otel.enabled` | OTel трейсы | bool | `false` |  |  | OK |  |
| `otel.endpoint` | endpoint OTLP | string | `` |  |  | OK |  |
| `otel.serviceName` | имя сервиса | string | `mma` |  |  | OK |  |
| `retry.maxRetries` | макс. повторов | int | `3` |  |  | OK |  |
| `retry.baseDelay` | базовая задержка повтора | int | `1000` |  |  | OK |  |
| `retry.maxDelay` | макс. задержка повтора | int | `30000` |  |  | OK |  |
| `retry.maxStreamRetries` | макс. повторов стрима | int | `2` |  |  | OK |  |
| `retry.noDataTimeoutMs` | таймаут застоя стрима (мс) | int | `180000` |  |  | OK |  |
| `pricing.enabled` | учет стоимости | bool | `true` |  |  | OK |  |
| `plugins.disabled` | выключенные плагины | list | `["angular11","telegram-notify"]` |  | plugins.gate | OK |  |
| `pricing.overrides` | переопределения цен | json | `{}` |  |  | OK | добавлена строка + заполнены обязательные поля |

### Вне PANEL_SECTIONS (кастомные контролы) — 6

| Ключ | Метка (RU) | Тип | По умолчанию | Алиасы | Эффекты | Тест | Примечание |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `model` | модель | string | `qwen/qwen3.5-9b` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | OK |  |
| `provider.active` | активный провайдер | string | `openai-compat` |  | provider.rebuild, context.resize, reasoning.reload, session.meta | SKIP | на стенде только один провайдер (llama.cpp) — альтернативы для переключения нет |
| `version` | версия | string | `0.26.0` |  |  | OK (read-only) | read-only footer value (app version, not config schema version) |
| `ui.theme` | тема | enum | `console` |  |  | OK | клик по карточке темы, конфиг обновлён |
| `ui.themeMode` | режим темы | enum | `auto` |  |  | OK |  |
| `ui.themeEffects` | эффекты темы | bool | `true` |  |  | N/A | ключ не имеет контрола в веб-панели (только API/CLI) |

## Post-fix note (2026-11-19)

Этот документ — снимок непатченного тега `v0_26_0`. Два `N/A`-finding ниже устранены в ветке `fix/settings-ia-gaps`:

- `security.contentScan.dangerousPatterns` — секция `security.scan` добавлена во вкладку «Shell и пути» (`src/modules/webui/assets/js/settings/panels-security.ts`);
- `security.approvals` — четыре ключа `hitl.*` / `compliance.*` получили дефы в `src/config/registry-extra-security.ts` и локализацию, поэтому секция больше не пустая.

Счётчики ключей выше (199 в локальном реестре, 200 в API-реестре стенда) описаны до правки; после неё центральный реестр содержит 203 ключа.
