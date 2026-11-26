# Build composition: декларативная сборка edition поверх ядра

**Дата:** 2026-11-26 · **Статус:** draft (норматив для новых волн) · **Ветка:** `docs/build-composition`

## 1. Контекст

Код уже умеет собирать агента из частей, но делает это императивно:

- `src/core/module-host.ts` даёт типизированный контракт (`ModuleDef`: `requires`, `critical`,
  `setup`, `teardown`, `health`, `tools`, `hooks`, `configKeys`) и топологический порядок;
- `src/config/registry.ts` даёт `setConfigValue` → `ConfigEffect` и `captureConfigSnapshot`;
- `src/config/domains.ts` даёт слои файлов и three-way merge с базовым снимком;
- `src/tools/index.ts`, `src/core/bootstrap/modules-phase.ts`, `src/core/commands/spec.ts` и
  `PANEL_SECTIONS` задают фиксированные наборы тулов, модулей, команд и панелей;
- `src/modules/plugins/` умеет находить плагины, проверять версии, включать/выключать их и
  перезагружать, но не упаковывает набор в поставку;
- `src/core/host.ts` (`LocalHost`/`RemoteHost`, `/v1/host`) — версионированный шов между
  поверхностями и одним runtime.

При этом нет **одного входа**, который описывает, из чего собран конкретный запуск. Любая
кастомизация — правка файла в сборке, а не выбор декларации. Это ровно то, что в
[`2026-11-05-mma-enterprise.md`](../ideas/2026-11-05-mma-enterprise.md) §16 названо
«политика в файле конфигурации» и не считается enterprise.

Источники решения:

- [`2026-11-10-monolith-split-design.md`](./2026-11-10-monolith-split-design.md) §3.1, §17
  (INV-S11): текущий демон — **enterprise-standalone**, но контракт расширяем; workspace,
  identity и хранилище токена — параметры, а не догмы.
- [`2026-11-19-harness-borrow-matrix.md`](../development/2026-11-19-harness-borrow-matrix.md)
  §2, P1: профили = `bundle` + внешние плагины + патч-файл, слой home-patch и `--patch` поверх,
  дамп итогового дерева конфига; стоимость `M`, гейт `tests/arch/config-effects.test.ts`.
  §5 прямо запрещает «всё — плагин, включая agent loop».
- [`2026-11-12-enterprise-auth-design.md`](./2026-11-12-enterprise-auth-design.md) §7: политика
  приходит с сервера, подписана, с TTL, и не переопределяется локальными флагами.
- [`2026-11-19-instruction-source-lifecycle-design.md`](./2026-11-19-instruction-source-lifecycle-design.md)
  INV-IS-1/3/4: снимок стабилен внутри хода, изменение фиксируется fingerprint'ом, у каждого
  источника есть владелец.
- Удалённая спека `2026-11-03-enterprise-deployment-design.md` (заменена идеей
  `2026-11-05-mma-enterprise.md`; доступна в git как
  `b612bcacf^:docs/specs/2026-11-03-enterprise-deployment-design.md`) давала эскиз
  `mma.enterprise.yaml` и оценивала пилот в 10–12 недель.

**Почему не «сделать enterprise-флаг»:** флаг в монолите локально пропатчится; по
[`2026-11-09-mma-enterprise-separate-version.md`](../ideas/2026-11-09-mma-enterprise-separate-version.md)
§3.1–3.3 enterprise — не режим и не издание с выключенными фичами, а то же ядро плюс сервисы
вокруг него. Настоящая цель этой спеки — **интерфейс сборки**, а не флаг-переключатель.

## 2. Цель и границы

**Цель.** Дать один декларативный вход (`edition`), который описывает набор модулей, тулов,
плагинов, конфиг-патчей и поверхностей; детерминированно разрешает его в снимок; применяет
снимок через уже существующие эффекты; проверяет полноту и совместимость; оставляет
проверяемый след в `session.jsonl`. Интерфейс пригоден и для локальной сборки, и как точка
подключения будущей подписанной политики.

**Non-goals.**

- Не менять петлю агента, `ToolExecutor.execute()` и enforced-политику (INV-9/22).
- Не строить control plane, OIDC/SCIM, RBAC/ABAC, model gateway и credential broker — это
  отдельные волны по `enterprise-auth` и enterprise-идеям.
- Не делать мульти-tenant на одном процессе: silo «1 процесс = 1 tenant» сохраняется.
- Не делать hot-swap внутри хода: снимок меняется только на границе запуска/хода.
- Не заменять `ModuleHost` и не делать «всё — плагин»: модульность остаётся через
  `ModuleHost`, ядро — фиксированным швом.

## 3. Термины

| Термин | Значение |
|---|---|
| **base** | Фиксированное ядро: agent loop, `ToolExecutor`, `ConfigStore`, `SessionLogger`, защищённые пути. Не выбирается манифестом. |
| **bundle** | Именованный набор модулей, тулов, плагинов и команд. |
| **patch layer** | Упорядоченный набор изменений конфига с владельцем (`id`, `source`, `order`, `checksum`). |
| **profile** | `base` + выбранные bundle + упорядоченные patch layers. |
| **edition** | Манифест сборки: profile + поверхности + привязка policy-провайдера. |
| **resolved tree** | Детерминированный снимок после применения всех слоёв; имеет `revision` (sha256). |
| **artifact** | Манифест + resolved tree + digest, пригодные для проверки и повтора сборки. |

`execution.profile` и `promptProfile` — другие понятия (профиль исполнения и профиль
промпта); они не являются build profile и в этой спеке не участвуют.

## 4. Инварианты

1. **INV-BC-1. Ядро не опционально.** Петля, enforcement, конфиг-стор, логгер сессии и
   always-on защищённые пути не могут быть исключены или подменены манифестом. Нарушение —
   ошибка валидации сборки, не предупреждение.
2. **INV-BC-2. Один вход сборки.** Наборы модулей/тулов/плагинов/команд/панелей выводятся из
   edition. Новые императивные исключения в `modules-phase.ts`, `tools/index.ts`,
   `commands/spec.ts` и `controls.ts` вне манифеста не допускаются; гейт проверяет, что
   реестры собираются через единый резолвер.
3. **INV-BC-3. Слои упорядоченны и имеют владельца.** У каждого patch layer непустые `id`,
   `source`, `label`; `order` — целое число; повтор `id` — ошибка; равный `order` разрешается
   по стабильной сортировке `id`. Поздний слой перекрывает ранний только в объявленных ключах.
4. **INV-BC-4. Применение только через эффекты.** Патч не пишет в чужой домен напрямую:
   `setConfigValue` → `ConfigEffect` → внедрённый апplier → `applyConfigEffects`. Гейт
   `tests/arch/config-effects.test.ts`: снимок → патч → эффекты → откат.
5. **INV-BC-5. Снимок, откат, воспроизводимость.** `build describe` печатает дерево без
   секретов; два применения одного манифеста к одному base дают одинаковую `revision`.
   Откат возвращает предыдущий снимок и не оставляет частично применённых эффектов.
6. **INV-BC-6. Секретов в артефакте нет.** Манифест, `revision`, событие и дамп содержат
   только ссылки на env/keychain, метки и fingerprint'ы; значения секретов и PII не пишутся.
7. **INV-BC-7. Managed не переопределяется локальным.** Слой с `source: managed://…` имеет
   приоритет по происхождению, а не только по `order`: локальный `--patch` не может ослабить
   managed-значение (продолжение INV-S11 и `enterprise-auth` §7). Попытка — fail closed с
   записью в аудит.
8. **INV-BC-8. Стабильность внутри хода.** Манифест резолвится один раз при старте и на
   границе хода; в середине хода дерево байтово неизменно. Событие сборки пишется в
   `session.jsonl` с `source: core` и не содержит содержимого файлов.
9. **INV-BC-9. Fail closed по контракту.** Неизвестный модуль/тул/плагин/поверхность,
   несовместимая версия (`minMmaVersion`), отсутствующий `critical`-модуль или конфликт
   владельцев ключа останавливают сборку с причиной, а не работой по умолчанию.
10. **INV-BC-10. Расширяемость под enterprise сохранена.** Workspace, identity, token store и
    policy provider — параметры edition; привязка подписанной политики с TTL не требует
    изменения ядра и не обходит enforcement.
11. **INV-BC-11. Локальный edition не урезан.** Локальная сборка — полноценный вариант ядра;
    `--no-dlp`, `--allow-tool` и подобные флаги не переопределяют managed-слой.

## 5. Контракт манифеста

Файл по умолчанию: `<workspace>/.mma/build.yaml`. Managed-слои задаются ссылкой, а не
встроенными секретами. Минимальный пример (все поля обязательны, если не указан дефолт):

```yaml
edition: enterprise-pilot          # строка, [a-z0-9-]+
version: 0.26.1                    # версия совместимого ядра
base: core-v1                      # идентификатор базового набора
modules:
  include: [session, execution, indexer, lsp, mcp, memory, skills, documents, browser, plugins]
  exclude: []                      # critical-модули здесь запрещены (INV-BC-1)
tools:
  tags: [safe, code]
  deny: [bash]
plugins:
  bundles: [corp-defaults]
  allowlist: []                    # пусто = все из bundles
patches:
  - id: corp-baseline
    source: managed://policy/corp-baseline
    order: 100
    values:
      security.network.allowLoopback: false
      sessionEncryption.enabled: true
      audit.notifier.enabled: true
  - id: workstation-local
    source: local://.mma/build.yaml
    order: 200
    values:
      browser.enabled: true
surfaces: [web, repl, daemon]
policy:
  provider: local-file             # local-file | signed-remote
  ref: null                        # для signed-remote — ссылка на пакет, не содержимое
integrity:
  digest: sha256:<computed>        # вычисляется резолвером, не пишется руками
```

Правила резолва:

1. Валидируется схема; `version` сверяется с текущим `package.json` (major/minor совместимость).
2. Проверяется наличие модулей/тулов/плагинов и `critical`; два слоя, меняющие один и тот же
   ключ без явного `order`, считаются конфликтом и отвергаются.
3. Слои сортируются по `(order, id)`; managed-слой не может быть перекрыт локальным в том же
   ключе (INV-BC-7).
4. Значения применяются только через `setConfigValue` + эффекты; эффекты применяет
   существующий апplier поверхностей (CLI/web/service).
5. Резолвер возвращает `{ edition, revision, tree, effects, layers }`; `tree` содержит только
   метки и fingerprint'ы, не значения секретов.

## 6. Интерфейс сборки

Команды (каталог — `src/core/commands/spec.ts`, хендлеры — handler-map, не цепочка `if`):

| Команда | Действие |
|---|---|
| `mma build describe [--json]` | Показать активный edition, revision, слои и итоговые метки (без секретов) |
| `mma build validate <path>` | Проверить схему, ссылки, версии и ordered layers без применения |
| `mma build apply <edition>` | Применить edition на границе запуска; записать событие |
| `mma build rollback` | Вернуться к предыдущему снимку; записать событие |

`apply` и `rollback` работают только вне хода; внутри хода они дают явную ошибку
`build-busy` (аналог `diffPrompt.cause === "none"` из INV-IS-1). В daemon-режиме команды
идут через `/v1/host/commands` с тем же контрактом; в web — через существующий адаптер.

## 7. События журнала

Новые аддитивные типы в `SessionLogEntry` (см. `src/modules/session/log-types.ts`,
`src/core/session-log-telemetry.ts`, эмиттер в bootstrap):

```jsonc
{
  "ts": "...",
  "type": "build_applied",
  "source": "core",
  "edition": "enterprise-pilot",
  "revision": "sha256:...",
  "previous": null,                // или sha256:... при предыдущей сборке
  "layers": [
    { "id": "corp-baseline", "source": "managed://policy/corp-baseline", "order": 100, "fingerprint": "sha256:abcd" }
  ]
}
```

```jsonc
{
  "ts": "...",
  "type": "build_rolled_back",
  "source": "core",
  "from": "sha256:...",
  "to": "sha256:...",
  "reason": "manual | validation-failed | policy-expired"
}
```

Содержимое файлов и значения ключей в событиях не пишутся (INV-BC-6). Replay обязан
tolerate неизвестные типы и проверять только структуру, как в `instructions_updated`.

## 8. Интеграция с существующими швами

| Шов | Что используется | Что добавляется |
|---|---|---|
| `ModuleHost` / `module-host-order.ts` | `register`, `setup`, `dispose`, `collectTools/Hooks/ConfigKeys` | резолвер выбирает набор до `setup()`; `unregister` не вводится |
| `src/config/registry.ts`, `effects.ts` | `setConfigValue`, `captureConfigSnapshot`, `applyConfigEffects` | patch layer как новый источник значений с приоритетом |
| `src/config/domains.ts`, `domain-io.ts` | base snapshot, three-way merge | `revision` снимка и откат к предыдущей revision |
| `src/tools/index.ts`, `filter-tools.ts` | tags, overrides, `toolAllowlist` | deny/allow из edition поверх runtime-фильтров |
| `src/modules/plugins/manager.ts` | gate, version, reload | bundle как декларация набора; lockfile плагинов в artifact |
| `src/core/host.ts`, `/v1/host/*` | единый интерфейс поверхностей | `build` команды и событие в daemon |
| `src/core/bootstrap/instructions.ts` | fingerprint, граница хода | тот же паттерн для layers |
| `src/modules/service/*` | silo, tenant/principal | `policy.provider` как параметр, без обхода enforcement |

## 9. Валидация и гейты

Новый гейт `tests/arch/build-composition.test.ts` обязан падать без правки и проверять:

1. схема манифеста: обязательные поля, допустимые `source`, целый `order`, уникальный `id`;
2. fail closed на неизвестный модуль/тул/плагин, отсутствующий `critical`, несовместимую
   версию, конфликт владельцев ключа;
3. одинаковая `revision` при повторном применении к одному base;
4. снимок → патч → эффекты → откат, без прямого изменения чужого домена (INV-19);
5. managed-слой не ослабляется локальным `--patch`;
6. секреты/PII отсутствуют в дампе, artifact и обоих событиях;
7. реестры собираются через резолвер: новый хардкод в `modules-phase.ts`, `tools/index.ts`,
   `commands/spec.ts` и `controls.ts` не проходит.

Дополнительно: `tests/docs-link-check.test.ts` (ссылки этой спеки), `bun test` и
`bun run quality` зелёные. Покрытие новых ветвей — по порогу CI (87% funcs / 90% lines).

## 10. Волны

| Волна | Результат | Критерий приёмки |
|---|---|---|
| **W-BC0. Контракт** | Схема манифеста, валидатор, `build describe`/`validate` без применения | Гейты 1–2 и 6 зелёные; невалидный манифест отклоняется с причиной |
| **W-BC1. Слои конфига** (P1 матрицы) | Упорядоченные patch layers, эффекты, снимок, откат | Гейты 3–5 зелёные; `tests/arch/config-effects.test.ts` расширен |
| **W-BC2. Наборы** | Модули/тулы/плагины/команды/панели выбираются edition; миграция хардкодов | Два edition загружаются с разными наборами; дефолтный путь без регрессий; гейт 7 |
| **W-BC3. Наблюдаемость и политика** | `build_applied`/`build_rolled_back`, привязка `signed-remote` по `enterprise-auth` §7 | События в `session.jsonl`, managed-правило не переопределяется, отказ пишется в аудит |
| **W-BC4. Поставка** | Edition в `scripts/stage-release.ts`, smoke-тест маленькой core-дистрибуции (P2 матрицы) | Сборка конкретного edition воспроизводима; тот же набор гейтов |

Оценка по шкале матрицы: W-BC0–W-BC3 — `M` (2–5 человеко-дней каждый), W-BC4 — `M`.
W-BC4 начинается только после W-BC1: без профилей второй путь сборки был бы лишним.
Каждая волна — отдельная ветка от `dev`, зелёная и откатываемая (правило 3 AGENTS.md).

## 11. Открытые вопросы с принятыми решениями

- **Где хранить манифест?** Решение: `<workspace>/.mma/build.yaml` для локального слоя;
  managed-слой — ссылка `managed://…`, не инлайн-значения. Причина: не делать секреты
  частью файла и сохранить совместимость с `.mmrc`/domain-файлами.
- **Кто меняет managed-слой?** В standalone — только администратор хоста через тот же
  интерфейс; в enterprise — control plane по отдельной спеке, подпись и TTL по
  `enterprise-auth` §7. Ядро не различает источник, кроме флага `managed`.
- **Hot-reload политики?** Решение: только граница хода/запуска, как INV-IS-1. Причина:
  попарность tool calls и KV-кеш.
- **Версионирование.** Новые ключи и модули — MINOR в `0.x.y` (бета, `1.x` запрещён);
  смена формата `session.jsonl` и REST/SSE-контракта описана этой спекой до кода.
  `CHANGELOG.md` не трогается без явной команды (правило 10 AGENTS.md).

## 12. Связанные документы

- [Идея MMA Enterprise](../ideas/2026-11-05-mma-enterprise.md) §7, §16
- [Enterprise как отдельная версия](../ideas/2026-11-09-mma-enterprise-separate-version.md) §3, §9, §13
- [Monolith split](./2026-11-10-monolith-split-design.md) §3.1, §17 (INV-S11)
- [Enterprise auth](./2026-11-12-enterprise-auth-design.md) §6–§8
- [Матрица заимствований](../development/2026-11-19-harness-borrow-matrix.md) §2, §5
- [Instruction source lifecycle](./2026-11-19-instruction-source-lifecycle-design.md) INV-IS-1/3/4
- [Архитектура v2](./2026-10-12-architecture-v2-design.md) INV-9, INV-19, INV-21, INV-22
