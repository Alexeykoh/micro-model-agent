# План: исправление багов по итогам полного аудита (2026-08-26)

> Аудит: 226 файлов, 6 параллельных субагентов. Отчёт — в этом же документе ниже.
> Режим: атомарные коммиты `fix(scope): description`, перед коммитом — `bun test` (затронутые файлы) + `tsc --noEmit`.

## Phase 1 — Critical/High (утечки ресурсов и процессы)

### T1. executor.ts: таймаут-таймер не очищается + unhandled rejection
- [ ] `clearTimeout` при завершении handler'а; снять abort-listener
- [ ] `.catch(() => {})` на проигравших в `Promise.race`
- [ ] Просроченный таймер не дёргает чужой `ctx.cleanup()`
- Done: тест «таймер очищается», «cleanup не зовётся после успеха»; существующие тесты executor зелёные

### T2. audit-notifier.ts: бесконечный retry-цикл
- [ ] `sendToWebhook` не кладёт копии в очередь из retry-пути; счётчик retries инкрементируется; backoff-ветка достижима
- Done: тест «после maxRetries запись покидает очередь»

### T3. bridge-server.mjs: осиротевший Chromium
- [ ] SIGTERM/SIGINT handler закрывает браузер; обработчик close на stdin → self-exit
- Done: ручная проверка kill родителя → нет висячего node/chromium

### T4. kill-tree.ts / lsp/client.ts: POSIX tree-kill не работает
- [ ] Спавн LSP с `detached: true` (POSIX), чтобы `kill(-pid)` работал
- Done: тест kill-tree убивает внуков (POSIX-only, skip на win32)

### T5. mcp/client.ts: таймеры разыменовывают this.process + нет initialize handshake
- [ ] Очистка таймеров при успехе; guard на `this.process`; отправка `initialize` перед `tools/list` для stdio
- [ ] Дисконнект при ошибке callTool (try/finally)
- Done: тесты mcp клиента зелёные

## Phase 2 — Security bypass

### T6. command-validator.ts: обход blacklist
- [ ] Снимать кавычки в extractBaseCommand; распознавать полные пути интерпретаторов; добавить `$(`/`<(` в dangerous operators
- Done: тесты `'rm' -rf /`, `/bin/bash -c ...`, `echo $(...)` блокируются

### T7. network-validator.ts: SSRF через альтернативные формы IP
- [ ] Декодировать decimal/hex/octal host и IPv6-mapped перед проверкой
- Done: тесты на все формы

### T8. Path/scope дыры в тулах
- [ ] move-file: scope по резолвнутым путям; grep-tool/glob-tool/attach-image/chunk-query: scope-check как у read_file
- Done: тесты «путь вне baseDir отклонён»

## Phase 3 — Целостность данных и MoE

### T9. agent.ts: dangling tool_calls после Esc (+ compaction cutoff в context/manager.ts)
- [ ] При break по shutdownRequested — синтезировать tool-сообщения или удалять assistant(tool_calls) из контекста
- [ ] Compaction: не резать пару assistant/tool
- Done: тест «история валидна после прерывания посреди батча»

### T10. moe-executor.ts: локале-зависимый парсинг артефакта + ретрай abort
- [ ] Парсить путь структурно (не по i18n-строке); AbortError не transient — проброс наверх
- Done: тест при ru-локали result_mode:"file" работает; abort не ретраится

### T11. config/config.ts: мелкая копия DEFAULTS портит синглтоны
- [ ] deep clone дефолтов при загрузке
- Done: тест «мутация загруженного конфига не меняет DEFAULT_*»

### T12. providers/manager.ts: toConfig сбрасывает fallback
- [ ] Сохранять реальное значение provider.fallback
- Done: тест hot-swap сохраняет fallback:true

## Phase 4 — Прочие High

### T13. ui/diff.ts: LCS без ограничения входа → OOM
- [ ] Cap на размер входа (напр. 2000 строк) + fallback к summary-diff
- Done: тест больших файлов не растёт по памяти сверх лимита

### T14. session-encryption: одна битая строка делает всю историю нечитаемой
- [ ] Per-line try/catch в decryptJSONL: битая строка → пропуск с предупреждением
- [ ] isEncryptedString: строгий префикс вместо lenient base64-декода
- Done: тест «битая строка не валит файл»

### T15. cli/repl-commands.ts: недостижимая команда "config migrate"
- [ ] Переименовать в подкоманду (`/migrate`) или роутить `config migrate` внутри команды config
- Done: `/config migrate` выполняет миграцию

### T16. core/agent.ts: мёртвая reasoning policy + set_thinking не применяется
- [ ] Флаги ставить ДО точки чтения политики; читать reasoningState.level при вызове LLM
- Done: тест «флаг hallucinationRetry доходит до политики», «set_thinking меняет запрос»

---

## Phase 5 — Medium backlog (отдельные коммиты, по одному багу)
- symlink в path-validator, glob-семантика, неатомарный plan-store, гонка meta.json,
  advance() затирает skipped, fact-extractor «0 failed», reasoning-only fallback дубль,
  двойной учёт usage, LSP byte-framing, project-root над песочницей, browser index mismatch,
  maxConsoleEntries мёртв, Tab-completion UI, /reload completer+hostBridge, configDir хардкод,
  security-команды затирают поля, async plugin hooks, walker statSync гонка, NaN context window,
  edit_file $&-replace, certification --scenarios×--tags, verifier кавычки путей

## Phase 6 — Low backlog
- см. отчёт ниже (i18n пустые ключи, ротация логов, maxSessions:0, правило #8 в repl*, `\|` в таблицах и др.)

---

# Отчёт аудита (2026-08-26)

## 🔴 Critical/High
1. `core/agent.ts:518-650` — reasoning policy всегда false (flags reset до чтения); iterPlanCreated никогда не true → auto-режим мёртв
2. `core/agent.ts:661-670` + set-thinking.ts — set_thinking не применяется к LLM-вызовам, но логируется как override
3. `execution/execution-plugin.ts:250` — recovery bash-flailing/consecutive недостижим (нет в гейте инъекции)
4. `tools/executor.ts:88-124` — таймер не очищается, стреляет в чужой ctx.cleanup; abort-listener накапливается; unhandled rejection от Promise.race
5. `security/audit-notifier.ts:283-300` — sendToWebhook глотает ошибки и кладёт копию в очередь со сбросом retries → вечный цикл, isProcessing залипает
6. `browser/bridge-server.mjs:201` — SIGTERM без закрытия браузера + нет stdin-close handler → сироты-chromium
7. `processes/kill-tree.ts:45` + lsp/client.ts — спавн без detached → kill(-pid) ESRCH → внуки осиротевают (POSIX)
8. `mcp/client.ts:294,466` — таймеры разыменовывают this.process! после disconnect → crash; stdio без initialize handshake
9. `security/command-validator.ts` — обход: кавычки `'rm'`, полный путь `/bin/bash -c`, `$()` не заблокирован
10. `security/network-validator.ts:15` — SSRF decimal/hex/octal IP, IPv6-mapped
11. `tools/move-file.ts:53,70` — scope по сырым путям, удаление резолвнутых; grep/glob/attach-image/chunk-query без scope-check
12. `core/agent.ts:854-894` — Esc оставляет dangling tool_calls → Jinja 400; compaction режет пару assistant/tool
13. `execution/moe-executor.ts:181` — парсинг артефакта по en-строке → ru-локаль ломает result_mode:"file"
14. `execution/moe-executor.ts:28` — "abort" в TRANSIENT → Esc во время MoE ретраится
15. `config/config.ts:213` — shallow copy DEFAULTS → мутации портят синглтоны процесса
16. `ui/diff.ts:13` — LCS без cap → OOM на больших файлах
17. `providers/manager.ts:127` — toConfig жёстко fallback:false, сброс при hot-swap
18. `security/session-encryption.ts:118` + encryption.ts:156 — битая строка = вся история нечитаема; isEncryptedString false positives
19. `cli/repl-commands.ts:218` — "config migrate" с пробелом недостижима

## 🟡 Medium
path-validator symlink+glob-substring; plan-store неатомарная запись; meta.json RMW гонка; advance затирает skipped;
fact-extractor «0 failed»→errors; openai-compat reasoning-only fallback дубль; двойной учёт usage; LSP char-vs-byte framing;
lsp probe root над песочницей; browser actions/snapshot индексы расходятся; maxConsoleEntries мёртв; line-editor Tab рассинхрон +
listeners утечка + non-TTY UTF-8; /reload ломает completer/hostBridge/execModule; configDir хардкод в wizard/model use/context;
security-команды затирают keyPath/webhookUrl; plugins manager async hooks вне try/catch; mcp module onSessionEnd без await;
walker statSync гонка + симлинк-циклы; setup NaN context window; edit_file $& replace; verifier пути без кавычек;
certification --scenarios без --tags даёт пустой выбор; cert mmaVersion при частичном re-run; indexer debounce гонки;
session rotate теряет meta; consistency deletedFiles не чистится; confidence overlap на повторах; plan-tool status enum не enforced;
chunk-query длинные строки; pipelines template $& + фантомные dep; skills loader statSync

## 🟢 Low
lastRetryAfter протечка; NaN quality при history=0; maxSessions:0 удаляет всё; ротация логов в обратном порядке;
i18n ""→сырой ключ; правило #8 в repl.ts/repl-commands.ts/commands.ts; таблицы \| ; box wrapText теряет пробелы;
md-formatter незакрытый fence; migration detect catch→true стирает конфиг; main() без .catch; completer trailing space;
plan-view currentStepIndex на завершённом плане; LSP banner поверх фрейма редактора
