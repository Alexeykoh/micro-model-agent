# Аудит волн B/C/D/E — 2026-09-25

**Ветка:** `docs/waves-bcde-audit` (от `master` @ `dc12778`)
**Основание:** `TODO.md` → P1 «Аудит волн B/C/D/E»; продолжение `docs/analysis/2026-08-29-agent-logic-audit.md`
и плана `docs/superpowers/plans/2026-08-26-model-control-fixes.md` (там уже закрыты Round 1–4 и волны 1–9).
**Метод:** 4 параллельных read-only аудита по волнам, с проверкой call-sites (`rg`) и severity 1–5
(5 — критично: потеря данных/безопасность/агент не работает). Ранее закрытые находки не переоткрывались.

- **Wave B** — `src/tools/*` (48 файлов)
- **Wave C** — `src/modules/execution/*` (20 файлов)
- **Wave D** — `session/logger/i18n/ui/output` + `cli/repl*`
- **Wave E** — `security/processes/providers/mcp/pipelines/indexer/skills/plugins/memory/hallucination/lsp`

Обозначения: `W-N` — сквозная; `B-N`/`C-N`/`D-N`/`E-N` — исходные из отчётов агентов.

---

## 1. Сводка по severity

| Sev | Кол-во | Находки |
|---|---|---|
| **4** | 6 | W-1 (symlink-обход записи), W-2 (scope clobber в MoE), W-3 (command injection в lint-on-write), W-4 (`plan update` без валидации статуса), W-5 (ложный автозакрыт шагов), W-6 (MCP-тулы не регистрируются) |
| **3** | ~24 | B-3…B-8, C-3…C-8, D-1…D-4, E-3, E-5…E-8, E-14 + сводный i18n |
| **2** | ~25 | B-9…B-15, C-9…C-16, D-5…D-9, E-9…E-15 |
| **1** | ~8 | B-16/B-17, C-17/C-18, часть dead code |

Самые важные — **W-1…W-6** (sev 4). Дальше по убыванию.

---

## 2. Severity 4 — критичное

### W-1 = B-1 = E-1 | Безопасность | Обход песочницы при записи через symlink/junction
**Где:** `src/modules/security/path-validator.ts:139` (`isPathWritable`), вызовы в `tools/write-file.ts:49`, `edit-file.ts:70`, `delete-file`, `move-file`, `create-dir`.
**Суть:** `isPathInScope` для чтения вызывает `escapesViaSymlink` (`:59`), а `isPathWritable` — **нет**. `resolve()` symlink не разворачивает, поэтому `isInsideDir` пропускает путь, а `writeFileSync`/`unlinkSync` идут по ссылке. Проверено: junction внутри `baseDir` → `outside`: `isPathWritable → allowed:true`, `isPathInScope → via symlink`.
**Влияние:** запись/удаление произвольных файлов вне `baseDir`; обход `security.paths.denied`.
**Фикс:** добавить `escapesViaSymlink(baseResolved, targetResolved)` в `isPathWritable` (и канонизировать родителя для ещё не существующего листа).

### W-2 = B-2 | Безопасность/изоляция | Параллельные MoE-субагенты затирают общий scope в `undefined`
**Где:** `src/tools/subagent.ts:168-176,269`; вызывает `modules/execution/moe-executor.ts:191-201` (контекст без `scope`).
**Суть:** `parentScope = ctx.scope` в MoE-контексте равно `undefined`; по завершении сабтаска `setScope(parentScope)` сбрасывает общий executor-scope в «без ограничений». Волны идут параллельно (`moe-executor.ts:475 Promise.all`), сиблинги гоняют `setScope`.
**Влияние:** теряется `allowed_files`/`read_only_files` изоляция; запись куда угодно в `baseDir`; сбрасывается глубина рекурсии.
**Фикс:** прокидывать родительский scope в конструируемый контекст и восстанавливать сравнением владельца (как `executor.ts:120` для `cleanup`).

### W-3 = E-2 | Безопасность | Command injection через путь файла в lint-on-write
**Где:** `src/modules/plugins/builtin/lint-on-write.ts:165,188,365-370`.
**Суть:** `spawn(command, { shell: true })` с `bun build ... "<filePath>"` / `node --check "<filePath>"`, где `filePath` — путь, заданный моделью (валидируется лишь на «внутри baseDir»). В двойных кавычках POSIX `$()`/бэктики, на cmd.exe `%VAR%` всё равно раскрываются.
**Влияние:** произвольное исполнение команд на каждой записи `.ts/.js`.
**Фикс:** не использовать `shell: true` (`spawn(cmd, [args])`) или шелл-эскейпить путь.

### W-4 = C-1 | Корректность | `plan update` пишет произвольный статус шага (`as any`)
**Где:** `src/modules/execution/plan-actions.ts:241,374` (`tracker.updateStepStatus(stepId, status as any)`); схема/enum в `tools/executor.ts` не проверяется.
**Суть:** статус — любая строка от модели («completed», «готово», «pending»). Не-терминальный статус → `isComplete()`/`getPlanProgress()` не сходятся, план вечно «не завершён»; `"pending"` молча переоткрывает `done`-шаг; мусор персистится в `.mma/plans/active.json`.
**Влияние:** зацикливание на плане, порча состояния, переживающая рестарт.
**Фикс:** валидировать `status ∈ {done,failed,skipped}` до мутации; убрать `as any`.

### W-5 = C-2 | Корректность | `autoCloseEvidenceSteps` ложно закрывает пустые/delete-шаги
**Где:** `src/modules/execution/module.ts:353-366`.
**Суть:** автозакрытие по «все упомянутые пути существуют», без проверки `kind` и непустого содержимого (в отличие от `advancePlanIfStepComplete:655-676`). Delete-шаг с ещё существующими файлами → `done`; create-шаг с пустым файлом → `done`, аудитор проверяет только существование → `passed:true`, персистится.
**Влияние:** ложное «готово», финальный аудит пропускает пустой деливерабл.
**Фикс:** пропускать `kind:"delete"`, пока цели не удалены; для create требовать `trim().length >= 10`.

### W-6 = E-4 | Mixed | MCP-тулы не регистрируются (bootstrap race)
**Где:** `src/modules/mcp/module.ts:90` (`discoverAllTools()` fire-and-forget) + `src/core/bootstrap.ts:758` (`collectToolDefinitions()` один раз).
**Суть:** `getToolDefinitions()` снимает снимок `discovered`; асинхронный `ensureConnected` пушит позже, но реестр уже собран. Почти для любого stdio/сетевого сервера реальные тулы недоступны; остаются placeholder'ы `mcp__server__connect`, которые рапортуют имена, не резолвящиеся как тулы.
**Влияние:** MCP фактически не работает (кроме generic `mcp_call`).
**Фикс:** дождаться (с таймаутом) discovery до `collectToolDefinitions` либо перерегистрировать тулы после lazy connect.

---

## 3. Severity 3

### B-3 | read_file: неограниченный `limit` + обход бюджета
`src/tools/read-file.ts:141`; тул `boundedOutput: true` → `truncateToolOutput` возвращает `MAX_SAFE_INTEGER` (`core/agent/tool-output.ts:22`). `limit: 1000000` затянет файл целиком. **Фикс:** клампить `limit` (напр. `DEFAULT_LIMIT*4`) и/или общий cap символов.

### B-4 | remember/recall возвращают `success:true` при ошибке хранилища
`src/tools/remember.ts:70-72`, `recall.ts:69-71` (`catch → success:true`). Ошибка диска = молчаливая потеря памятки. **Фикс:** `success:false`.

### B-5 | download_file обходит always-on protected-path guard
`src/tools/download-file.ts:62-73` — вызывает `isPathWritable`, но не `protectedPathBlock` (в отличие от write/edit/delete/move/create). `download_file {path:".env"}` перезапишет секрет. **Фикс:** вызвать `protectedPathBlock` (+ `writePathAllowlist`).

### B-6 | SSRF через редиректы
`download-file.ts:78`, `web-browse.ts:45`, `web-fetch.ts:81` — `fetch` со стандартным `redirect:"follow"`, проверяется только исходный URL (`isUrlAllowed`). Публичный URL → 302 на `127.0.0.1`/`169.254.169.254`. **Фикс:** `redirect:"manual"` + ре-валидация каждого хопа.

### B-7 | mcp_call утекает клиент/процесс при ошибке
`src/tools/mcp-call.ts:65-79` — `disconnect()` не вызывается, если `callTool` бросил. **Фикс:** `try/finally`.

### B-8 | read_file `offset: 0` → `slice(-1, end)` возвращает последнюю строку
`src/tools/read-file.ts:140,155-156`. **Фикс:** `Math.max(1, offset)`.

### C-3 | bash-flailing и consecutive-failure никогда не доходят до модели/лога
`execution-plugin.ts:264-268` — гейт recovery не включает `hasBashFlailing()`/`hasConsecutiveFailures()`, а `getStuckReason()` их не описывает. Именно ради «8 разных падающих shell-трюков (ses_mt4x3zbo)» детектор и делался. **Фикс:** добавить оба в гейт и в `getStuckReason`.

### C-4 | `stuckDetector.reset()` каждый iteration убивает детект петель **до** плана
`execution-plugin.ts:214` (`tracker` null → `reset()`), а `runOnBeforeThink` — раз в итерацию. Стираются `recentToolCalls`/`toolErrors`/`readOnlyStreak`/`bashRecent`. **Фикс:** использовать `resetStepProgress()` (сохраняет историю), счётчик plan-nudge — отдельно.

### C-5 | Тип/синтакс-ошибка на «успешной» записи тут же гасится `recordToolSuccess()`
`execution-plugin.ts:417-423` пишет `recordToolError`, `:473-474` в том же хуке делает `recordToolSuccess()` → счётчики обнуляются (`lint-on-write` оставляет `success:true`). **Фикс:** не звать `recordToolSuccess()` при `hasTypeError`.

### C-6 | MoE selective re-plan падает, когда все подзадачи уже успешны
`moe-executor.ts:376-387`: `skipIds` покрывает всё → `subtasks=[]` → `waves=[]` → «possible cycle», циклы выгорают, carried-результаты теряются. **Фикс:** возвращать успех с carried-clones.

### C-7 | `verifyMoEManifest` только baseDir → ложные reject/approve во вложенных проектах
`verifier.ts:218-231` (`runTypeCheck`, `checkFileExists`), тогда как `verifyStep` использует nested-aware `findExistingFile:262`. **Фикс:** `findExistingFile` + `runTypeCheckForFile`/`findTypecheckRoot`.

### C-8 | MoE внешний StuckDetector сбрасывается на каждой попытке
`moe-executor.ts:153-156` — `recordIteration(attempt)` меняет stepId → `resetStepState`. Порог недостижим, `stuckReason` мёртв. **Фикс:** стабильный stepId (из `subtask.id`).

### D-1 | Секреты в session-логах: санитайзятся только user/tool
`core/session-logger.ts:50-56` (`logSystem`), `:72-106` (`logAssistant`), `:108-117` (`saveAssistantMessage`), `:307-313` (`logError`) пишут сырой контент (в отличие от `logUser`/`logToolResult`). При `sessionEncryption.enabled=false` (дефолт) — plaintext. Эхо секрета моделью → секрет в `history.jsonl`/`session.jsonl`; также утечка срезов AGENTS.md. **Фикс:** санитайзить/редактить на уровне `SessionStore.append*`.

### D-2 | `mma provider use` не персистится при `provider.entries[]`
`src/cli/commands.ts:463-474` — ветка entries делает `agent.setProvider(name)` и `return` до `saveConfig`. Печатает «Provider set», теряет при выходе. **Фикс:** `saveConfig` после успеха.

### D-3 | Локаль применяется после `createProgram()` → `--help`/typo-подсказки на английском
`main.ts:68` создаёт программу (eager `t(...)`) до `bootstrap` (`setLocale` в `bootstrap.ts:308`), typo-guard (`main.ts:152-161`) ещё раньше. **Фикс:** `setLocale` до `createProgram`/ленивые описания.

### D-4 | `LineEditor.tabComplete` печатает список, который тут же стирает `render()` (DSR)
`line-editor.ts:971-988` + `render():1106` (`\x1b[J`, сброс ниже фрейма); `frameTopAbs` не инвалидируется (в отличие от `printAbove`). На Linux/macOS список кандидатов мигает и исчезает; тесты форсят `MMA_DSR=0`. **Фикс:** `invalidateAnchor()` после печати списка.

### E-3 | Парсер frontmatter скиллов LF-only → все CRLF-скиллы выпадают
`src/modules/skills/loader.ts:47` (`/^---\n.../`). Бандл `builtin/git.md` на Windows — CRLF; проверка `loadFromDir` → `[]`. **Фикс:** нормализовать `\r\n` → `\n` перед regex.

### E-5 | SSRF: неканонический IPv6-loopback
`security/network-validator.ts:61-63` — `isIpPrivate("0:0:0:0:0:0:0:1")===false`, `::ffff:0:7f00:1` тоже. **Фикс:** канонизировать через `node:net`/`ipaddr`, сверять `::1`, `::ffff:127.0.0.0/8`, `::`.

### E-6 | Path traversal в `recall` (category не валидируется)
`modules/memory/store.ts:27-31` (`join(memoryDir, name + ".md")`), `recall.ts:111,126`; JSON-schema `enum` не enforced. `category:"../../…/notes"` читает произвольный `.md`. **Фикс:** валидировать имя по фиксированному списку в `MemoryStore`.

### E-7 | Процессный реестр: неограниченный буфер частичной строки
`modules/processes/registry.ts:135-181` — `MAX_LOG_LINES` капает только завершённые строки; `buf`/`byteBuf` растут до `\n`. **Фикс:** кап на частичный буфер (~64KB).

### E-8 | Коллизия MCP-имён роняет bootstrap
`mcp/module.ts:18-22` + `tools/registry.ts:7-8` (throw на дубль): серверы `a.b`/`a-b` или тулы `x.y`/`x-y` → crash при старте. **Фикс:** дизамбигуация хэш-суффиксом + дедуп до register.

### E-14 | Обход bash-валидатора обёртками/версионированными интерпретаторами
`security/command-validator.ts:52-79,145-149`: `"nice rm file"` → allowed; `"python3.11 -c 'x'"` → allowed (regex требует `python3` + пробел). **Фикс:** пропускать флаги обёрток, `python3(?:\.\d+)?`.

### Сводный i18n (B-12 + C-14 + D-9) | Hardcoded English в model/user-выводе
Тулы: `subagent.ts:263,275`, `pipeline-run.ts:94…`, `mcp-call.ts:51…`, `chunk-query.ts:82…`. Execution: `verifier.ts:71-116`, `execution-plugin.ts:488,493`, `moe-executor.ts:44`, `module.ts:452,455`, `stuck-detector.ts:521-610`. CLI/UI: `repl.ts:1128-1240`, `repl-commands.ts:1015-1374`, `commands.ts:569`. **Фикс:** через `t()` (часть ключей `verify.*` уже есть) + ключи в en/ru.

---

## 4. Severity 2 (выборочно)

- **B-9** `pipeline_run` не читает/не инкрементит `recursionDepth` → guard не срабатывает (`pipeline-run.ts:102`).
- **B-10** module-level singleton `PipelineEngine` шарится между параллельными вызовами (`pipeline-run.ts:14,118`).
- **B-11** `readLineSlice` переоценивает `total` для файлов >1MB (`read-file.ts:71-74`).
- **B-13** пустые `catch {}` без логов: `syntax-validator.ts:120,150`, `auto-fixer.ts:98`, `bash.ts:234`, `search-history.ts:15`, `scope-request.ts:100` (правило #14).
- **B-14** `process_log` документирует cap 300, но не клампит `tail` (`process-log.ts:20,45`).
- **B-15** `preValidateSyntax` отвергает валидный JSONC (`tsconfig.json`) (`syntax-validator.ts:87-94`).
- **C-9** `plan-coverage` свой парсер путей → `e.g`/`i.e` как «отсутствующие файлы», реальные `.css/.html` не проверяются (`plan-coverage.ts:1,28-44`).
- **C-10** `deleteReadOverlap` по префиксу строк → `main.ts` vs `main.tsx` ложный конфликт (`plan-validator.ts:177-182`).
- **C-11** `applyAutoFixes` мутирует входной план (shallow `{...s}`, shared `depends_on`) (`plan-validator.ts:211-225`).
- **C-12** фиксированное имя tmp в `PlanStore` + необработанный `renameSync` → гонка двух процессов (`plan-store.ts:42-48`).
- **C-13** `recordToolSuccess()` сбрасывает `escalationCount` (анти-гейминг ломается) (`stuck-detector.ts:385` vs `:898`).
- **C-15** `StepVerifier.runAsync` на таймауте убивает только shell → сироты-`tsc` (`verifier.ts:363-366`); есть `killTree`.
- **C-16** правило #10: решение о тестах по keyword-regex по описаниям шагов (`audit-runners.ts:24-25,110-112`).
- **D-5** fenced code сразу после таблицы выводится до таблицы (`md-formatter.ts:196-223`).
- **D-6** `logSessionStart` dedup не работает при шифровании → дубль `session_start` (`session-logger.ts:349-361`).
- **D-7** `rotateOldSessions` — мёртвый код (никем не вызывается) (`session/store.ts:389-416`).
- **D-8** non-TTY `LineEditor.onData` эмитит хвост чанка как строку (`line-editor.ts:295-313`).
- **E-9** MCP discovery timeout не отменяет и не чистит; поздний успех регистрирует «failed» сервер (`mcp/module.ts:106-131`).
- **E-10** MCP stdio id из `Date.now()` — коллизии (`mcp/client.ts:232-234`).
- **E-11** MCP SSE: один слот `pendingResolve`, матч по любому id → перекрёстные ответы (`mcp/client.ts:126,482-524`).
- **E-12** дебаунс typecheck в lint-on-write глобальный, не per-project (`lint-on-write.ts:273-284`).
- **E-13** `statSync` без try/catch в plugin loader → одна битая запись роняет старт (`plugins/loader.ts:32`).
- **E-15** `killTree` синхронно блокирует event loop (`taskkill` дважды + `sleepSync`) (`processes/kill-tree.ts:13-53`).

## 5. Severity 1 (гигиена)

- **B-16 = E-прим.** `src/tools/scope-check.ts` — мёртвый дубликат (импортируется только тестом; без symlink/glob проверок) → удалить/реэкспорт.
- **B-17** `isInsideDir` отвергает легитимные имена, начинающиеся с `..` (`path-utils.ts:27`).
- **C-17** `typecheckFailures.clear()` гасит ошибку чужого файла при успешной записи (`execution-plugin.ts:430-436`).
- **C-18** мёртвый/неиспользуемый API: `plan-persister.ts`, `stuck-detector` (`classifyError`/`getHints`/`getToolAlternative`/…), `PluginManager.runOnBeforeTool` (`=== false`, не обрабатывает string-контракт).
- **D-нот.** мёртвый TODO-комментарий `main.ts:255-257`; `mma config set` в обход `setConfigValue` (`commands.ts:100-117`); `/reload` не переснимает `configSnapshot`; `/resume` теряет `tool_calls`/`tool_call_id`.

---

## 6. Рекомендуемый порядок фиксов

1. **Безопасность/целостность (sev 4):** W-1 (symlink-запись), W-3 (injection), W-5 (ложный автозакрыт), W-4 (валидация статуса), W-2 (scope clobber), W-6 (MCP registration).
2. **Детект застревания (дешёво, заметно):** C-3, C-4, C-5, C-8, C-13 — все в `execution-plugin`/`stuck-detector`.
3. **Утечки/секреты/SSRF:** D-1, B-5, B-6, E-5, E-6, B-7.
4. **Корректность планов:** C-6, C-7, C-9, C-10, C-11, C-12.
5. **MCP-надёжность:** E-8, E-9, E-10, E-11, W-6 follow-up.
6. **i18n-свод:** B-12/C-14/D-9.
7. **Гигиена:** dead code (B-16, C-18, D-7), мелкие клампы (B-3, B-8, B-14), B-17.

---

## 7. Покрытие (проверено, чисто)

- **Wave B:** approve, attach-image, browser, chunk-query, create/delete/move-dir/file, edit-file, enable-tools, executor, file-info/list-dir/glob, filter/hidden-tools, registry/types, grep, load-skill, session-info/set-thinking/question/user-input/prompt-io, process-kill/list, search-history, web-search, tool-batch/images/output-капы.
- **Wave C:** plan-steps, planner, tracker, types, transient-error, windows-commands, input-from, plan-tool, прочие actions plan-actions, audit-runners (кроме C-16), auditor, прочие пути verifier, moe-executor (кроме C-6/7/8), прочие пути execution-plugin, module, прочие stuck-detector, plan-store.
- **Wave D:** session/store, session/manager, export, logger, i18n (паритет 1250/1250), output/*, md-formatter, renderer, line-editor (кроме D-4/D-8), completer, repl/commands.
- **Wave E:** security (encryption, sanitizer, audit-log/notifier, rate-limiter, isolation, protected-paths, policies), processes (runner), providers целиком, MCP HTTP-транспорт, indexer (кэш уже валидируется), skills/module, plugins/manager, memory (search/module), hallucination, lsp.

## 8. Замечания к решениям

- **W-1/E-1** и **W-2** зависят от трактовки изоляции: если scope — это «подсказка», нежели граница безопасности, W-2 понижается до 3. Но восстановление `undefined` вместо родителя неверно в любом случае.
- **B-6/E-5** актуальны только при `security.network.enabled=true`; иначе всё разрешено by design.
- **B-15 (JSONC)** — суждение: гейт синтаксиса намеренный, но блокировка комментированного `tsconfig.json` провоцирует цикл слабой модели.
- `download_file` читает тело целиком в память до проверки размера (`download-file.ts:101`) — задокументировано в коде, не заводилось как находка.
- `bash.decorateCommandOutput` head-truncates не-тестовый вывод до 15 строк (`bash.ts:477-481`) — возможно by design, нужно решение.
- Правило #10 не нарушено bash-хинтами (классифицируют вывод shell, а не задачу); `audit-runners.ts` (C-16) — нарушает.

---

*Составлено 2026-09-25. Исходные отчёты агентов (Wave B/C/D/E) сведены без потери `file:line`; дубликаты между волнами помечены (W-1=B-1=E-1, сводный i18n).*
