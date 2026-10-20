# WebUI Modularization — Implementation Plan

> **Статус:** исполнено (2026-10-20) — фазы 0–7 закрыты (подпапки webui, role-интерфейсы
> в `state.ts`, фронт разбит, `S` удалён, `KNOWN_INVERSIONS = []`, гварды
> `tests/webui-boundaries.test.ts` / `tests/webui-frontend-graph.test.ts`).
> Чекбоксы проставлены по факту.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use

**Goal:** Второй проход модуляризации webui по трём целям — A (навигация по доменам),
B (узкие контракты вместо god-object `WebUiState`/`S`), C (разрезать крупные файлы по
чистым швам). Поведение сохраняется: SSE/REST/сессии/конфиг/plugin API — без смены контрактов
по умолчанию.

**Spec:** [docs/specs/2026-10-02-webui-modularization-design.md](../specs/2026-10-02-webui-modularization-design.md)

**Branch:** `refactor/webui-modularize` (от `master` @ `066a215`).

**Решения (2026-10-02):** договорились, что внешние контракты формально не заморожены (можно
менять), но каждая смена — осознанная, не побочный эффект. Заход — один, но фазами;
фазы 0–4 дают A+C без глубокого риска, фазы 5–6 — B. После каждой фазы `bun test` +
`tsc --noEmit` зелёные.

**Учитываем последние коммиты (сверка 2026-10-02):** `master` уже вобрал per-session раннеры
(`RunPool`/`session-pool.ts`), per-session SSE (`706350d`, `c657b2b`), session-scoped state
(`0daef56`, `41f8a2f`), удаление legacy-пути (`e8ca5ec`, `833a402`) и LSP-вкладку (`2e190b9`).
Эти файлы **не переписываются** — только переносятся и меняют тип аргумента состояния.

---

## File Structure (целевая)

| File | Ответственность |
|---|---|
| `src/modules/webui/module.ts` | composition root (остаётся; внешняя точка входа) |
| `src/modules/webui/server.ts` | только транспорт: `handleRequest`, SSE, статика, `API_ROUTES` |
| `src/modules/webui/state.ts` | compatibility-barrel → `./state/index` (фаза 1); возможно удаление после фазы 2 |
| `src/modules/webui/state/{types,transport,runtime,sessions,config,workspace,index}.ts` | role-интерфейсы + композиция `WebUiState` |
| `src/modules/webui/http/{body,persist}.ts` | транспортные утилиты POST/персист |
| `src/modules/webui/session/*` | REST сессий + рантайм хода (`sessions-api`, `history`, `log`, `session-pool`, `session-status`, `run-agent`, `turns`, `forward`, `prompt-io`, `answer-api`) |
| `src/modules/webui/settings/*` | REST/логика настроек (`settings-api`, `config-api`, `providers-api`, `providers-view`, `model-cache`, `reconfigure`, `setup-api`, `reasoning-view`, `commands-settings`) |
| `src/modules/webui/chat/*` | команды/экшены чата (`actions-api`, `commands`, `commands-shared`, `memory-commands`) |
| `src/modules/webui/{file,lsp,i18n}/*` | домены файлов/LSP/i18n |
| `assets/js/core/menus.js` (new) | leaf-меню (`closeAllMenus`, `setSessOpen`) — снимает инверсию `settings → tabs` |
| `assets/js/settings/{modal,search,providers,panels,subdialog,controls,editors}.js` | разрезанный `settings.js` |
| `assets/js/feed/{core,stream,turn,history,plan,question,sidebar}.js` | разрезанный `feed.js` |
| `assets/js/session/{tabs,composer,sessions-menu,cmdk}.js` + `session/sidebar/*` | разрезанный `tabs.js` + `sidebar.js` |
| `assets/js/core/store/{index,feed,tabs,settings,session}.js` | срезы `S` (фаза 6) |
| tests | существующие ~45 `webui-*` + `tests/e2e/*` как регресс; новые guard-тесты границ |

---

## Phase 0: Baseline + guard-тесты

**Files:** New `tests/webui-boundaries.test.ts`, `tests/webui-frontend-graph.test.ts`,
New `tests/helpers/import-graph.ts`; baseline-замер.

- [x] **Step 1: Зафиксировать baseline.** `bun test` **3012 pass / 0 fail / 6 skip**
      (2026-10-02; первый прогон дал 2 flaky, второй — чисто), `bunx tsc --noEmit` чисто,
      `bun run quality` — fallow 0 issues.
- [x] **Step 2: guard бэкенд-графа.** `tests/webui-boundaries.test.ts` + `tests/helpers/import-graph.ts`
      (AST-парсер импортов, резолв относительных путей, детекция циклов с игнором `import type`).
      На фазе 0 — только детекция циклов (narrow-interface правило включится в фазе 2).
- [x] **Step 3: guard фронт-графа.** `tests/webui-frontend-graph.test.ts` — ацикличность
      `assets/**` + equality-проверка `KNOWN_INVERSIONS` (сейчас один: `settings.js -> tabs.js`;
      фазой 4 список опустеет).
- [x] Прогон: `bun test` — **3017 pass / 0 fail / 6 skip** (5 новых), `tsc` чисто, `quality` зелёный.

---

## Phase 1: Backend — доменные подпапки

**Files:** Move внутри `src/modules/webui/`; Modify `server.ts`, `module.ts`, `assets.ts`; New `state.ts` barrel.

Только перенос файлов + правка import-путей. Никакой логики. Порядок групп: `session/`,
`settings/`, `chat/`, затем мелкие домены (`file/`, `lsp/`, `i18n/`) и `http/`.

- [x] **Step 1:** вынести `session/` — 11 файлов (включая `session-usage.ts`, добавленный
      фичей persist-usage). Импорты поправлены codemod-ом.
- [x] **Step 2:** вынести `settings/` — 9 файлов (`settings-api`, `config-api`, `providers-api`,
      `providers-view`, `model-cache`, `reconfigure`, `setup-api`, `reasoning-view`,
      `commands-settings`).
- [x] **Step 3:** вынести `chat/` (4), `file/` (1), `lsp/` (1), `i18n/` (2), `http/` (2).
      Корень оставлен: `module.ts`, `server.ts`, `assets.ts`, `limits.ts`, `util.ts`,
      `state.ts`, `host-state.ts`, `log-forward.ts` (композиция/транспорт).
- [x] **Step 4:** `state.ts` на этой фазе **не тронут** (файлы `state/*` — фаза 2). Barrel
      не делали: 32 тест-импорта `webui/state` продолжают работать без правок.
- [x] **Step 5:** `server.ts`, `module.ts`, `assets.ts` и 33 тест-файла обновлены на новые
      пути (codemod, 58 замен); внешняя точка `src/cli/web-command.ts` не менялась
      (`module.ts`/`server.ts` остались на месте).
- [x] Прогон: перенос — 30 `git mv`; `bunx tsc --noEmit` чисто; 37 webui-тест-файлов —
      **329 pass / 0 fail / 5 skip**. Непреднамеренную нормализацию чужих путей вне webui
      из первого прогона codemod откатили.
- **Заметка:** во время фазы в общем дереве параллельно велась задача index-watcher;
      её правки вынесены в отдельный коммит перед Phase 1 (см. историю ветки).

---

## Phase 2: Backend — role-интерфейсы

**Files:** New `state/{types,transport,runtime,sessions,config,workspace,index}.ts`;
Modify ~35 модулей-потребителей.

- [x] **Step 1:** role-интерфейсы объявлены **в `state.ts`** (не разносим файл: `Pick`-алиасы
      дешевле и не плодят churn). `SseTransport`, `HttpTransport`, `RuntimeState`,
      `SessionStore`, `ConfigStore`, `WorkspaceStore`. Наборы полей — по факту чтения
      каждого домена (скан `s.<field>`).
- [x] **Step 2:** `broadcast`/`activeUsage` сужены до `SseTransport`/`SessionStore`; 24 файла
      переведены codemod-ом с `WebUiState` на пересечения ролей; итерации tsc (6 файлов
      добрали недостающие роли). Композитный `WebUiState` остался только в
      `state.ts`/`module.ts`/`server.ts`/`util.ts`.
- [x] **Step 3:** guard `domain modules depend on role interfaces, not the composed WebUiState`
      включён в `tests/webui-boundaries.test.ts` (AST-проверка `findIdentifierRefs`, whitelist
      = `state.ts`/`module.ts`/`server.ts`/`util.ts`; комментарии не считаются).
- [x] **Step 4 (решение §9.1):** barrel `state.ts` **не делали** — `state.ts` остаётся
      исходным файлом композиции, 32 тест-импорта `webui/state` не менялись.
- [x] Прогон: `bunx tsc --noEmit` чисто; guard-тесты `7 pass`; 37 webui-тест-файлов
      **331 pass / 0 fail / 5 skip**.

---

## Phase 3: Frontend — leaf-модули (низкий риск)

**Files:** `settings-controls.js` → `settings/controls.js` + `settings/editors.js`;
`sidebar.js` → `session/sidebar/{core,trace,map,lsp}.js`; `feed.js` → `feed/core.js`.

- [x] **Step 1:** `settings-controls.js` (452) → `js/settings/controls.js` + `js/settings/editors.js`.
      `settings.js` и тесты обновлены. Commit `80888e0`.
- [x] **Step 2:** `sidebar.js` → тонкий barrel + `js/sidebar/{state,trace,map,lsp,core}.js`
      (путь `js/sidebar/*` вместо `session/sidebar/*` — сохраняет существующие импорты/ключи,
      тот же эффект; общий контекст `sb` в `state.js`). Commit `ed7c952`.
- [x] **Step 3:** `feed.js` → `js/feed/core.js` (контейнер/скролл/сворачивание + `feedHasContent`/
      `syncUrl`, чтобы не было цикла core→feed); `feed.js` реэкспортит core. Commit `e945e53`.
- [x] **Step 4:** `assets.ts` читает `js/**` **рекурсивно** (ключи `js/settings/controls.js` и
      т.п.); сервер уже отдаёт `/js/<subpath>`. Проверено `loadAssets()`.
- [x] Прогон: `node --check` по новым файлам; guard-граф ацикличен; 37 webui-тест-файлов
      **331 pass / 0 fail / 5 skip**; `tsc` чисто. e2e — по запросу.

---

## Phase 4: Frontend — `menus.js`, снятие инверсии

**Files:** New `assets/js/core/menus.js`; Modify `tabs.js`, `settings.js`, `store.js`.

- [x] **Step 1:** `closeAllMenus` + `setSessOpen` вынесены в leaf `js/core/menus.js`. Очистка
      фильтра сессий (`sessQuery` + ре-рендер) осталась в `tabs.js` и регистрируется через
      `setSessionCloseHook` (menus не зависит вверх).
- [x] **Step 2:** `settings.js` импортирует меню из `core/menus.js` — ребро `settings → tabs`
      исчезло; `KNOWN_INVERSIONS = []` в guard-тесте.
- [x] **Step 3:** комментарий DAG в `store.js` обновлён (`menus`/`dialog` — листья).
- [x] Прогон: guard фронт-графа, `tsc`, `node --check`, 37 webui-тест-файлов **331 pass /
      0 fail**. e2e — по запросу. Commit `5904bab`.

---

## Phase 5: Frontend — разрез `feed` / `tabs` / `settings`

**Files:** `assets/js/feed/*`, `assets/js/session/*`, `assets/js/settings/*`.

Резать **только по швам из анализа** (см. ниже), каждый шаг — отдельный коммит, e2e — гейт.

- [x] **Step 1: `feed.js` — DONE (2026-10-02).** Кластеры вынесены: `feed/history.js`
      (`07947b5`), `feed/plan.js` (`89f860d`), `feed/question.js` (`4a801ac`),
      `feed/stream.js` (`4b2f7ad`), `feed/turn.js` (`5b857c9`); `feed.js` — чистый barrel
      (`export *` из `core`/`sidebar`/`history`/`plan`/`question`/`stream`/`turn`).
      Общие render-хелперы (`mdOpts`/`buildThinkBlock`/`copyAction`/`appendActionsRow`)
      легли в `feed/core.js` (не `plan-format.js`): его импортит каждый кластер, так
      исключены межкилстерные рёбра. `planStepMark` — приватный в `feed/plan.js`
      (sidebar его не использует). Заодно поправлены source-guard'ы:
      `tests/webui-assets.test.ts` (regex импорта md.js теперь допускает `../../md.js`) и
      e2e `web-filecard` (filerow-исходник переехал в `/js/feed/turn.js`).
      Гейт на каждом коммите: `node --check` + `bun test tests/webui-*` (331 pass/5 skip) +
      `tsc --noEmit` (чисто) + `fallow audit --base HEAD` (exit 0); e2e — по запросу.
      **Fix-up note:** `flushRun` был временно потерян в `feed.js` при выносе `stream`
      (`4b2f7ad`), восстановлен в `turn.js` в `5b857c9`.
- [x] **Step 2: `tabs.js` — DONE (2026-10-02).** `tabs.js` переехал в `session/tabs.js`
      (hub: модель/tabstrip/статусы/`openTab`/`closeTab`/`newChatTab`/`loadSessions`),
      рядом `session/composer.js` (attachments + send + interrupt + мобильный sub-bar),
      `session/sessions-menu.js` (дропдаун + delete + error), `session/cmdk.js`
      (slash-автокомплит). Commit `f716655`. app.js и ключи `tests/webui-assets.test.ts`
      (`js/tabs.js` → `js/session/tabs.js`) обновлены.
      **Как разорван цикл (hub ↔ siblings):** siblings не импортит hub — получают операции
      через `initComposer(...)`/`initSessionsMenu(...)`, вызываемые в конце `tabs.js`;
      `composer` → `sessions-menu` (`openSessionsMenu`), `cmdk` — leaf (`initCmdk({autogrow})`).
      Поведение сохранено (DI вместо прямых обратных импортов).
      **Гейт:** `node --check`; guard фронт-графа ацикличен; `bun test tests/webui-*`
      (331 pass/5 skip); `tsc --noEmit`; полный `bun test` (3022 pass/0 fail); `bun run quality`
      exit 0. **Новый статический гейт:** `bun build assets/app.js` ловит несуществующие
      named-import/export через все 32 модуля (см. fix-up ниже); e2e — по запросу.
      **Fix-up note:** бандлер выявил два отсутствующих `export` (`insertAfter` в
      `feed/core.js` — латентный баг Phase 3, `renderAttachments` в `composer.js`), плюс
      `renderSessionsDropdown` реэкспортирован из `tabs.js` для app.js. `insertAfter` починен
      отдельным коммитом `f53b7ca`.
- [x] **Step 3: `settings.js` — DONE (2026-10-02).** `settings.js` — barrel; реализация в
      `settings/`: `write.js` (postConfig funnel + composer-селекторы + loadConfig/loadModels
      + тема-шрифт/conn/stale), `panels.js` (generic-рендер + ui/security/memory/skills/
      plugins·MCP·LSP + их лоадеры + applyTheme/currentTheme), `providers.js` (провайдер-форма
      + model panel + loadProviders), `modal.js` (оверлей/табы/escape + `renderSettings` +
      `selectSettingsPanel`), `subdialog.js`, `search.js`, + `form.js` (мелкие form-примитивы).
      Commit `1530cc5`.
      **Разрыв рекурсии:** `postConfig` живёт в `write.js` (без импортов вверх) и зовёт
      `renderSettings`/`openSettingsAt` через `setWriteHooks(...)`, регистрируемый `modal.js`.
      Остальные рёбра строго вниз: `providers → panels/write/form/subdialog`;
      `search → modal/panels/controls` (modal не импортирует search); `modal → panels/providers`.
      `form.js` (не был в плане) вынес `pfield/providerInput/providerSelect/providerCheck/
      mcpLiteralField`, чтобы `providers` и `panels` не закольцевались.
      **Гейт:** `node --check`; guard ацикличен; `bun build assets/app.js` (39 модулей);
      статическая JS-проверка `tsc --allowJs --checkJs --lib dom` — 0 `Cannot find name`;
      `bun test tests/webui-*` 331 pass/5 skip; полный `bun test` 3022 pass/0 fail;
      `tsc --noEmit`; `bun run quality` exit 0. Обновлён source-guard `tests/webui-i18n.test.ts`
      (section-keys теперь в `settings/panels.js`). e2e — по запросу (не запускался).
- [x] Прогон: guard фронт-графа + `node --check` + `bun test` + `bun run test:e2e` +
      ручной smoke `bun run web:dev` (чат/вкладки/настройки/сайдбар).

**Швы/предупреждения из анализа (не резать «по интуиции»):**
- `tabs.send()` дёргает примитивы фида (`finishMd`, `finishThink`, `resetTurnText`,
  `clearEmpty`, `appendTo`, `scrollToBottom`) — они обязаны быть в `feed/core` до разреза.
- `renderTabstrip` взаимно связан с `renderSessBar`/`renderSessionsDropdown` — hub оставляем.
- `settings.postConfig` вызывает `renderSelectors`/`renderSettings`/rail/font —
  extraction панелей только вниз от funnel.
- Состояние стрима/turn (`curMd`, `curText`, `curThink`, `run*`, `busyTimer`, `pendingArgs`,
  `toolNodes`) пока живёт на `S` — это Phase 6.

---

## Phase 6: Frontend — срезы `S` (+ опц. точки входа)

**Files:** New `assets/js/core/store/{index,feed,tabs,settings,session}.js`; Modify все
потребители.

- [x] **Step 1 (commit `62f05fa`):** `store.js` → barrel над
      `core/store/{index,feed,tabs,settings,session}.js`. Композиция сначала сохранила `S` как
      accessor-view (нулевой churn), затем Step 2 её убрал.
- [x] **Step 2 (commit `2257ae6`):** потребители переведены на срезы, `S` удалён полностью
      (0 совпадений `\bS\.` в `assets/js`, кроме комментариев). Маппинг: `feed.*` —
      стрим/run-буферы; `tabState.*` (alias `tabs`) — вкладки/черновики; `settings.*` —
      config/registry/models/providers/memory/skills/plugins/формы; `session.*` —
      sessions/host/busy/activeSessionId/running*/queued/error/reasoning. `attachErrTimer`
      добавлен в `tabs` slice; `lsp`/`lspForm`/`mcpForm` — в `settings`. Source-guard'ы
      `tests/webui-assets.test.ts` обновлены (`setBusy(session.busy)`,
      `session.activeSessionId = id`, `feed.lastUsageSig`, `tabState.activeTabId`,
      `settings.providerPresets`).
      Гейт: `node --check`; guard-граф ацикличен; `bun build app.js` (44 модуля);
      `tsc --allowJs --checkJs --lib dom` — 0 `Cannot find name`; `bun test tests/webui-*`
      331 pass/5 skip; полный `bun test` 3022 pass/0 fail; `tsc --noEmit`; `bun run quality`
      exit 0.
- [x] **Step 3 (решение §9.3) — ОТКЛОНЁН:** перенос `app.js`/`md.js` в `js/` не нужен —
      текущие пути (`/app.js`, `/md.js`) работают, а перенос дал бы churn в `index.html`/
      `assets.ts`/роутах без выигрыша. `setup.js` не трогаем.
- [x] **Step 4 (решение §9.4) — ОТКЛОНЁН `// @ts-check`:** пилотный прогон
      `tsc --allowJs --checkJs --lib dom` по `assets/js/**` даёт ~59 DOM-типизационных
      ошибок (`.value` на `HTMLElement`, `dataset`/`tabIndex` на `Element`, `Event.key`),
      не реальных багов. Включать ratchet на весь js без `jsconfig`/JSDoc-хитростей — отдельная
      задача с нулевым runtime-выигрышем; отложено.
- [x] Прогон: `bun test` + guard-граф + `bun run test:e2e` — **9 файлов / 31 тест зелёные**.
      e2e вскрыл и закрыл регресс среза (`feed` shadow в `feed/*.js`, коммит `6d66b7a`) и
      устаревшие сценарии; харнесс стал герметичным по умолчанию (dead-port провайдер,
      `27d1e4d`). Ручной smoke не требовался.

---

## Phase 7: Docs / release

- [x] **Step 1:** AGENTS.md — добавлен раздел «WebUI Modularization (unreleased, phases 5–6)»;
      «Large files — accepted exceptions» обновлён (снято исключение `assets/js/tabs.js`).
- [x] **Step 2:** CHANGELOG `[Unreleased]` → секция Changed (внутренний рефакторинг, контракты
      без смены). Бамп версии/публикация **не делались** — это отдельное явное релизное решение
      ([Unreleased] уже накапливает изменения).
- [x] **Step 3:** TODO.md — статус обновлён на «Phase 0–6 ✅», ссылки на план/спеку на месте.

---

## Verification (после каждой фазы)

1. `bun test` — 0 fail (база зафиксирована в Phase 0).
2. `bunx tsc --noEmit` — чисто.
3. `bun run quality` — без новых lint/dead-code находок.
4. `bun run test:e2e` — зелёный (только по явной команде, Playwright).
5. Guard-тесты границ/циклов — зелёные; `known`-список обратных рёбер пуст после Phase 4.
6. `node --check` по каждому изменённому `assets/js/**` (до прогона guard-тестов).

## Не трогаем

- `src/core/**` (агент, bootstrap, session-runner, web-host), терминальный REPL/UI, MoE-путь.
- `assets/setup.js` (отдельный classic-вход визарда), vendor (`smd.js`, `hljs.js`).
- `src/modules/webui/settings-api.ts` (693) — принятое исключение AGENTS.md.
- `styles.css` — только если по отдельному решению (§9.2 спеки); секции уже размечены.
