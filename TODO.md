# TODO — Micro Models Agent

> **Актуально на 2026-11-04** (`dev` @ 0.24.0).
>
> Здесь только **открытая** работа. Закрытые пункты с обоснованиями и ссылками на
> гейты сохранены снимком в [`docs/archive/todo-2026-11-04.md`](./docs/archive/todo-2026-11-04.md).
> Долгосрочная история — `CHANGELOG.md` и [`docs/agents/feature-history.md`](./docs/agents/feature-history.md).
> Отложенные решения — [`docs/agents/debt.md`](./docs/agents/debt.md) (правило 9, pay-once).

---

## 1. Открыто сейчас

> Разделы 1.1–1.4 и 1.7–1.11 закрыты и перенесены в архивный снимок. Нумерация
> оставшихся разделов сохранена, чтобы не ломать ссылки вида `TODO §1.12` в коде,
> спеках и тестах.

### 1.5 Мелкие хвосты исполненных планов

- [ ] Режим компакции `llm`: `contextBudget.compactionSummary` допускает только
      `off|ledger` (`src/config/registry-extra.ts:182`). Файл
      `src/core/compaction-summary.ts` **есть и используется** в `ledger`-режиме —
      не хватает именно LLM-режима (сводка моделью) и его проводки в конфиг.
- [ ] Живая приёмка леджера контекста: повторный прогон `hard-multi-extreme` с acceptance
      «`NEEDLE_A_111`/`B_222`/`C_333`, decoy 0, `exit=0`, notes-файл с `path:line`, блок
      с `[Notes:`» (план [`2026-10-14-context-ledger`](./docs/archive/plans/2026/2026-10-14-context-ledger.md), Task 6).

### 1.6 Качество памяти и самообучение (план [`docs/plans/2026-08-12-memory-quality-and-learning.md`](./docs/plans/2026-08-12-memory-quality-and-learning.md))

План **в работе**: Phase A (валидатор памяти) и Phase C (языковые адаптеры) закрыты
2026-11-03, Phase B (обучение) открыта.

- [ ] **Фаза 2 — обучение:** `src/modules/learning/**` (`types/trace/validator/generator/cli/module`),
      подкоманда `mma learn`, регистрация `LearningModule` в bootstrap.

### 1.12 mma web — хвосты тестовых прогонов 2026-11-02

Отчёт: [`docs/archive/reports/web-agent-test-report-2026-11-02.md`](./docs/archive/reports/web-agent-test-report-2026-11-02.md).
Остальные находки прогонов (MCP-теги, path-гейт, pre-write LSP, post-build, финальный
typecheck, loopback, `--isolated`, локальные заглушки) закрыты и перенесены в архив.

- [ ] **Вложенный `AGENTS.md` и `.mma/`** — mma не читает `site/AGENTS.md` Next 16, а
      `.mma/` в корне ломает `create-next-app .`. Долг F-01/F-06.

### 1.13 mma web — UX-задачи (добавлено 2026-11-04)

- [x] **Пауза агента с возобновлением по кнопке** — остановить ход агента и
      продолжить его по нажатию кнопки в интерфейсе. Реализовано на ветке
      `feat/webui-ux-1-13` по спеке
      [`docs/specs/2026-11-06-webui-pause-resume-design.md`](./docs/specs/2026-11-06-webui-pause-resume-design.md):
      гейт на границе итераций (`loop-run.ts`), `POST /api/pause`, проекция
      `pausedIds` в SSE `state`, кнопка в композере перед стоп/отправкой
      (`#pauseBtn`, иконки pause/play — как у send-кнопки). Тесты:
      `tests/core/agent-pause.test.ts`, `tests/webui-pause.test.ts`,
      `tests/webui-pause-dom.test.ts`. Не-durable (в памяти процесса) —
      durable `interrupt()` остаётся в P1 дорожной карты.
- [x] **Цепочка базовых веток в чипе `⎇` (строка под полем ввода)** — чип ветки
      в футере (`footer.ts:buildGitChips`) теперь показывает путь наследования
      суxo, стрелками: `⎇ main → dev → feat/x`; полная цепочка дублируется в
      title чипа (`from: …`). Источник — reflog создания ветки
      (`branch: Created from <ref>`, фолбэк `Created from HEAD` — первый вход
      в ветку из reflog HEAD): модуль `src/modules/webui/git/base-branch.ts`,
      цепочка строится рекурсивно (кап глубины 6, защита от цикла) и
      мемоизируется в кеше снимков (`snapshot-cache.ts:baseMemo`) — запись
      создания неизменна, git не спрашивается каждый тик. Невестно/не-репо/
      detached — чип остаётся `⎇ feat` без выдумывания. Гварды —
      `tests/modules/webui/git-base-branch.test.ts` (реальный git во временном
      репозитории) + кейсы чипа в `tests/webui-workspace-footer.test.ts`.
- [x] **Заголовок вкладки браузера — имя текущего чата** — `mma web` держал
      статичный `<title>MMA Web</title>`. Теперь `document.title` следует за
      активной сессионной вкладкой: `<имя чата> · MMA`, без активной сессии /
      для мёртвой вкладки — базовый `MMA Web`. Точка синхронизации одна —
      `renderTabstrip` (`src/modules/webui/assets/js/session/tabs-strip.ts`,
      чистая функция `pageTitle`): через неё проходят и переключение вкладок,
      и переименование (автонейминг сервера приходит в `updateTabName`).
      Гвард — `tests/webui-doc-title-dom.test.ts`.
- [x] **Звуки уведомлений — включить по умолчанию + пункт в первой настройке** —
      сейчас `ui.sounds.enabled` выключен по умолчанию: дефолт в
      `src/config/defaults.ts:205` (`sounds: { enabled: false, done: true,
      question: true, failed: true }`) и fallback в
      `src/config/registry-sounds.ts:17` (`key !== "enabled"`); зеркало дефолтов —
      `src/modules/webui/assets/js/sounds.ts:25`, гвард —
      `tests/webui-sounds.test.ts`. Сделать `enabled: true` во всех четырёх местах
      (и обновить гвард/тесты, сверяющие дефолт). Дополнительно: вынести выбор
      звуков уведомлений в первую настройку агента (onboarding/meet —
      `src/modules/onboarding/`), чтобы пользователь при старте явно решал,
      включать ли звуки; ответ пишется в `ui.sounds.enabled` через ConfigStore.
      Проверка — живой прогон `mma web` (звук по завершении хода/вопросу) и
      `bun test tests/webui-sounds.test.ts`.
- [x] **Вкладка «Изменения»: не подтягивает свежий git-стейт** — после фактических
      изменений рабочего дерева (правки/`git add`/commit) открытая вкладка Changes
      показывает устаревший список, пока не переключить вкладку. Причина: прирост
      `filesRevision` на клиенте вызывает только `sidebarFilesChanged()`
      (`src/modules/webui/assets/app-state.ts:58`), а предопределённый
      `sidebarGitChanged()` (`src/modules/webui/assets/js/sidebar/git.ts:167`,
      перечитывает `/api/git/changes`) нигде не вызывается — мёртвый код. Сервер
      снимок инвалидирует по той же ревизии (`src/modules/webui/module.ts:150`,
      `gitPeek`), т.е. свежий стейт доступен — клиент не запрашивает. Починить
      реактивность: вызывать `sidebarGitChanged()` на рост `filesRevision` (как
      `sidebarFilesChanged`), обновлять и индикатор вкладки
      (`sidebarGitIndicator`, `core.ts:126`). Нужен живой прогон в `mma web`.
- [x] **Сайдбар: компактный набор вкладок** — видимыми оставить вкладки
      «Сессия», «Файлы», «Изменения», «Субагенты»; остальные спрятать за кнопкой со
      «стрелочками вправо»: клик показывает все вкладки, кнопка переворачивается
      «влево», повторный клик скрывает раскрытое.
- [x] **Адаптивные табы сайдбара (подписи по контейнеру)** — `.sb-tabs` стал
      size-контейнером (`container: sbtabs / inline-size`, `flex-wrap:nowrap`);
      подписи `.sb-lab` скрыты по умолчанию и включаются `@container`-порогами:
      свёрнутый набор — от 450px, раскрытый — от 880px (класс `sb-expanded`
      навешивает `sidebar/compact-tabs.ts`). Без ellipsis и переноса: не
      хватает места — только иконки, не влазятся и они — горизонтальный
      скролл полосы. Правка канона U7 («labels always visible») по явному
      требованию; активная вкладка подпись не теряет (`.sb-name`). Гвард —
      `tests/webui-sidebar-tabs-css.test.ts`.
- [x] **Вкладка «Файлы»: предпросмотр в основном окне** — перенести просмотр
      файлов из сайдбара в основное окно как вкладку (как в IDE).
- [x] **Адаптивность заголовка блока критика** — свёрнутая строка проверки
      (`.think.critic-block > button.think-h`, `src/modules/webui/assets/styles.css:307`,
      рендер `src/modules/webui/assets/js/feed/critic-block.ts:onCritic`) ломается на
      узкой ширине: `.think-h` — `display:flex; gap:8px` без `flex-wrap`, а `.lab`
      (длинная строка `web.feed.critic_head` + статус «замечание/критично») без
      `min-width:0`/`overflow`, поэтому наезжает на `.tog`. Сделать адаптивным:
      `min-width:0` + ellipsis на `.lab`, `flex: 0 0 auto` на глиф/тоггл, либо
      перенос на узких экранах.
- [x] **Попап `@`: релевантный файл не первый в списке** — при вводе `@` в
      композере (`src/modules/webui/assets/js/session/mentions.ts`) список
      строится из `/api/search?names=1`, а сервер отдаёт пути в алфавитном
      порядке обхода (`src/modules/webui/file/search.ts:148` —
      `entries.sort(localeCompare)` по имени), без ранжирования по релевантности
      совпадения. Самый подходящий файл оказывается внизу списка, а Tab/Enter
      вставляет первый (`acceptMention(index)`, `index = 0` по умолчанию).
      Нужно сортировать/ограничивать выдачу по релевантности (префикс имени >
      подстрока имени > подстрока пути, кратчайший путь — выше) хотя бы для
      `namesOnly`-режима, чтобы первым шёл наиболее вероятный выбор.
- [x] **После обновления чат не форматируется в Markdown** — сообщения в ленте
      выводятся «сырым» текстом, хотя разметка (заголовки, списки, код)
      присутствует. Проверить рендер потока (`src/modules/webui/assets/js/feed/stream.ts`
      — `mountMarkdown`, `feed/core.ts`, нормализация `md-normalize.ts`):
      регресс после обновления — вероятно, ответ перестал проходить через
      `renderMarkdown`/`mountMarkdown` (например, вставляется как `textContent`
      или `mountMarkdown` падает молча). Нужен живой прогон в `mma web` для
      воспроизведения. **Итог проверки:** статически путь цел — `onText` рендерит
      через `mountMarkdown`, история через `renderMarkdown`, `md.js`/`smd.js`
      доставляются настоящими. Контракт зафиксирован e2e-тестом
      `tests/webui-md-feed-e2e.test.ts` (4/4). Дефект в живом прогоне не
      воспроизведён; если повторится — начинать с журнала консоли браузера
      (падает ли ESM-граф).
- [x] **Редактирование запланированных сообщений в поп-апе** — очередь сейчас
      только показывает строки с кнопками «▶ запустить» и «× отменить»
      (`src/modules/webui/assets/js/session/queue.ts:renderQueueStrip`), текста
      сообщения изменить нельзя. Нужен поп-ап по клику на строку очереди: поле с
      текстом (и приложенными картинками) + «Сохранить/Отмена». Сервер действия
      не имеет — есть только `POST /api/queue/cancel` и `POST /api/queue/start`
      (`src/modules/webui/session/queue-api.ts`), значит нужен третий эндпоинт
      `POST /api/queue/edit {sessionId, id, text}` + обновление локального
      `PendingMessage` (и текста серверной записи, иначе после `turn_end` в ленту
      уйдёт старый текст).

---

## 2. Действия пользователя (не задачи для агента)

- [ ] Вернуть `contextWindow 64000` в реальном конфиге (`~/.mma`) — сейчас 32768
      (проверено 2026-10-30): `/config contextWindow 64000`.

---

## 3. Дорожная карта до продакшена

> Полный gap-анализ: [`docs/archive/specs/2026/2026-09-28-production-readiness-design.md`](./docs/archive/specs/2026/2026-09-28-production-readiness-design.md).
> Пункты — отдельные ветки от `master`; каждый требует зелёных `bun test` + `bun run quality`.

### P0 — без этого в прод нельзя

- [ ] **Изоляция исполнения.** Enforcement уже в одной точке (`ToolExecutor.execute()`,
      W2: allowlist, protected-пути, SSRF, теги, rate-limit; `bash` — `manual` + jail).
      **Осталось:** профиль исполнения `local-trusted | sandbox` (Docker: deny-by-default
      egress, `--read-only`, лимиты, фиксированный образ), файловые тулы под jail,
      egress-правила для web-тулов, cert-сценарии приёмки.
      При `sandbox` и недоступном Docker ход **падает**, а не деградирует.
- [ ] **Durable state.** `session.jsonl` не переживает краш посреди хода:
      опциональный checkpointer, стабильный `thread_id` <255, prune по retention,
      long-term store с TTL.
- [ ] **Observability (OTel).** GenAI-спаны (`gen_ai.*` v1.41), OTLP-экспорт,
      метрики faithfulness/drift/bypass, связка trace↔session↔cost↔approvals.
- [ ] **Evals в контуре + staged rollout.** Eval-набор с trajectory-оценкой,
      ensemble-судья + human-gold, eval-gate в CI, shadow→canary→percentage→full,
      скоркард (success/cost/p95/safety).

### P1 — управляемость

- [ ] **Cost/LLM-gateway.** Per-run бюджет, `max_turns` hard-stop, per-tenant caps
      до вызова модели, intent-routing, cache-anchoring промпта.
- [ ] **MCP/plugin supply-chain.** OAuth 2.1 per-user, gateway с allowlist/rate-limit,
      signed skill-манифесты/SBOM, актуализация спеки MCP.
- [ ] **HITL + kill-switch.** Durable `interrupt()`, escalation по impact,
      oversight-панель, глобальный kill-switch (`question`/`approve` не переживают рестарт).
- [ ] **Поставка и эксплуатация.** Dockerfile/`K8s`/`/healthz`, релиз-артефакт,
      манифест (prompt+model+tools+evals), откат одной командой, RBAC/тенанты,
      SLO + runbook.

### P2 — зрелость

- [ ] **Compliance (EU AI Act).** Append-only логи + подпись, high-risk артефакты
      (risk file, lineage, oversight-панель, adversarial-лог Art.15), retention ≥6 мес.
- [ ] **Внутренние хвосты.** `noExplicitAny` warn-ratchet → error; coverage-threshold
      в CI; остаток раздутых файлов (allowlist пуст с 2026-11-03).

---

## 4. Бэклог

- [ ] Подобрать литературу по верификации/критикам (вторая половина пункта
      «контр-агент для проверки работы»; сам контр-агент сделан — `src/modules/critic/`).
- [ ] Долги из [`docs/agents/debt.md`](./docs/agents/debt.md) — каждый оплачивается
      по своему триггеру (правило 9).

---

## 5. Релиз

- Публикация — **только через GitHub Releases** (npm publish не используется).
- Версии в бете — только `0.x.y` (`1.0.0` запрещён, гвард `tests/version-beta.test.ts`).
- Релиз = обновление `CHANGELOG.md` + `package.json` → тег `vX.Y.Z` → GitHub Actions.

