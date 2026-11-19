# mma web — отчёт о тестировании агента

Дата: 2026-11-01
Стенд: `mma web` из `src/`, изолированный `MMA_CONFIG_DIR` (`%TEMP%\mma-agent-test`,
копия `~/.mma/config` без API-ключей), порт 4319, Chromium через Playwright.
Модель: `nvidia-nemotron-3.5-bolt-e4b` (LM Studio, 131 072).

> **Итог:** 20 прогонов, 20 находок (2 критичные: обрыв стрима = успех, `approve` не работает).
> Сводная таблица — в конце («Итоговая таблица (все прогоны)»), приоритеты — в
> «Рекомендации по приоритету», разбор причин — в «Анализ причин (по каждой находке)».

## TL;DR — причины (краткая карта)

| # | Находка | Причина | Уверенность |
|---|---|---|---|
| 1 | Дата как PII | `pii/rf.ts:48` — lookahead отсекает только `T`-форму; `confidence 0.4 == minConfidence` | высокая |
| 2 | `API_TOKEN=…` не режется | `secrets.ts` — нет ключа `api_token`, значение < 8 символов; `machine.ts:38` — только системные env | высокая |
| 3 | `.env` читается тулом | `path-enforcement.ts:53` — protected проверяется лишь для пишущих тулов | высокая |
| 4 | Сырой секрет в `directive` | `session-logger.ts:220` санитайзит лог, а в контекст идёт `result.output` | высокая |
| 5 | Вердикт критика не виден | `critic-gate-log.ts:66` пишет только в лог; в SSE есть лишь `retract` | высокая |
| 6 | Дубль субагента | `subagent-result.ts:52` — результат есть; поведение модели | средняя |
| 7 | Ответ теряется на гейте | `hallucination-gate.ts:149` — `retractDraft` + `block` (политика) | высокая |
| 8 | Нет текста в снапшоте браузера | `browser/actions.ts` — тело функции в `page.evaluate` → `SyntaxError` | высокая |
| 9 | Клик по номеру не работает | та же причина: `data-browser-index` не проставляется | высокая |
| 10 | `approve` не разблокирует | `session-runner-scope.ts:111` — у контекста раннера нет `approvals` | высокая |
| 11 | MCP `isError` = ✓ | `mcp/module.ts:214` — поле не читается, всегда `success:true` | высокая |
| 12 | `setup_done` не закрывает визард | `sse.ts:195` — только `faceEvent("done")` | высокая |
| 13 | Запись вне воркспейса | `security.ts` — `paths.enabled=false`; `path-validator.ts:56` jail только при `true` | высокая |
| 14 | 114 667 сессий-призраков | **не установлена**; автоочистка навсегда отключается при >1000 | — |
| 15 | Обрыв стрима = успех | `openai-compat.ts:314` — `if (sawDone \|\| emitted) return` | высокая |
| 16 | Сырой текст ошибки | `openai-compat.ts:905` — `throw err` без обёртки `LlmError` | высокая |
| 17 | Security-ключи без hot-apply | `registry-extra.ts:28` — `effects: reconfigure ? REBUILD : []` = `[]` | высокая |
| 18 | Компакция не идёт | **не установлена** — предикат `manager.ts:523` должен срабатывать | — |
| 19 | «context loaded» 80.1K | `sidebar.ts:205` — печатает окно провайдера, скрывает только по модели | высокая |
| 20 | Критик не видит изображение | `critic/evidence.ts:26` — в пакете нет вложений; `critic-gate.ts:189` зовёт критика и без тулов | высокая |


## Базовый конфиг (из рабочего, до правок)

- `security.enabled=true`, `bash.enabled=false`, `paths.enabled=false`, `network.enabled=true`
- `security.network.deniedDomains`: localhost, 127.0.0.1, ::1; `allowPrivateOutbound=false`
- `contentScan.enabled=false`, `sessionEncryption.enabled=false`, `auditNotifier.enabled=false`
- `dataPolicy.enabled=true`, pseudonymize=true, все `egress.*`=true, `failClosed=true`,
  `trustLocalClients=true`, `minConfidence=0.4`, `trustedHosts=[]`
- `webSearch.enabled=true`, `errorWebSearch.enabled=true` (threshold 5, 3 поиска/сессия)
- `lsp.enabled=true`, engine `typescript-language-server`
- `ui.verbosity=quiet`, `showReasoning=true`, `locale=ru` → в стенде `en`

## Быстрая сводка

| # | Блок | Статус | Заметки |
|---|---|---|---|
| 1 | Защищённые пути (`/api/file`) | PASS | `.env`, `*.key`, `.git/config`, `../outside` → 403; `safe.txt` → 200 |
| 2 | ADS / регистр (Windows) | PASS | `.env:stream` → 404 (обхода нет); `.ENV` → 403 |
| 3 | Поиск не течёт | PASS | `q=SECRET_TOKEN` не вернул `_testing/sec-probe/.env` (только тесты/доки) |
| 4 | `apiHiddenGlobs` | PASS | `private/**` → поиск 0 результатов, `/api/file` → 404 (не раскрывает существование) |
| 5 | `/api/config` list-ключи | NOTE | массив в `value` → 400 `invalid-value`; нужна JSON-строка (так шлёт UI). Не баг, но API неочевиден |
| 6 | Files-листинг | NOTE | `_testing/` не виден в `/api/files` (gitignored) — ожидаемо, но стоит помнить при тестах |

## Прогон 1 — безопасность без модели

### Защищённые пути (always-on, при `security.paths.enabled=false`)

| Запрос | Результат |
|---|---|
| `package.json` | 200, содержимое |
| `_testing/sec-probe/safe.txt` | 200 |
| `_testing/sec-probe/.env` | **403** «This file is protected (secrets/VCS)» |
| `_testing/sec-probe/secret.key` | **403** |
| `.git/config` | **403** |
| `../outside.txt` | **403** «outside the agent workspace» |
| `_testing/sec-probe/.env:stream` | 404 (ADS-обход не сработал) |
| `_testing/SEC-PROBE/.ENV` | **403** (регистр не обходит) |

### Поиск и скрытие

- `GET /api/search?q=SECRET_TOKEN` → совпадения только в `tests/` и доках, содержимое `.env` **не утекло**.
- `apiHiddenGlobs=["private/**"]` → `q="hidden inner"` даёт **0**, `/api/file?path=private/inner.txt` → **404**.
  Намеренно 404, а не 403: существование скрытого пути не раскрывается. ✔

### Наблюдения

- `POST /api/config` принимает `value` **только строкой**; массив/объект → `400 invalid-value`.
  UI сериализует сам, но внешний клиент об этом не знает. Кандидат в доку/валидацию.
- `/api/files?path=` прячет `_testing/` (как gitignored). Для e2e-проб это значит,
  что проверять файловые сценарии надо в `src/` или `docs/`.

## Прогон 2 — ход агента и DLP

### Ход 1 (локальная модель, `lmstudio`)

Промпт: «Read package.json and tell me the version. Answer in one short line.»

| Что наблюдал | Результат |
|---|---|
| Стриминг reasoning | `✦ thinking low · 2.2s [show]` — блок есть, уровни честные |
| Тулы | `◇ Reading file · package.json ✓` — 1 вызов, аргумент в строке |
| Critic-гейт | `↺ draft retracted: critic` → повторная генерация |
| Ответ | `0.22.0` (верно) |
| Метрика | `⟡ 1 tool · 46.7s` |
| DLP-бейдж | `DLP` (clean, 0 редакций) — локальный провайдер доверенный |

**PASS.** Гейты (critic), стриминг, рендер тула и ответ работают.

### DLP на внешнем провайдере

Стенд: подставной OpenAI-совместимый сервер `_testing/dlp-stub.ts` на
`0.0.0.0:4599`, провайдер `dlp-probe` с `http://26.109.182.121:4599/v1`
(не-loopback → «external»), модель `probe-model`.

Промпт: `Echo this back exactly: key sk-probe-SECRET-1234567890 and API_TOKEN=abc123 and path C:\Users\Alexe\secret.txt`

Что **реально ушло** (лог стаба):

```
Date: <PII:f7e12b44b06a> 19:19:35 +03:00
Workspace: <PATH:62c385f0feef> ... OS: Windows_NT <HOST:61962e1bf470>, Shell: <PATH:...>\system32\cmd.exe
key [SECRET] and API_TOKEN=abc123 and path <PATH:fc925c2f9280>\secret.txt
```

| Проверка | Результат |
|---|---|
| Секрет `sk-probe-…` | **PASS** — заменён на `[SECRET]` |
| Абсолютный путь пользователя | **PASS** — `<PATH:…>` |
| Путь воркспейса / shell | **PASS** — `<PATH:…>` |
| Хост/платформа | **PASS** — `<HOST:…>` |
| Дата/время | **PASS (редакция)** — `<PII:…>` |
| `API_TOKEN=abc123` | **не отредактирован** (см. находку 2) |
| Бейдж `DLP` | **13** редакций: пути 3, машина 3, env 1, секреты 1, PII 5 |
| Подпись назначения | `external provider: 26.109.182.121` |
| `session.jsonl` | `egress_redacted` (секретов 1) + `egress_turn` `total:13` |

**PASS** по механике: редакция, счётчик, детализация по классам, назначение
external/local, журнал сессии — всё сходится.

> Первый замер бейджа дал «0» — это была гонка (я читал бейдж предыдущего хода).
> После `turn_end` значение корректное (13). В отчёт записал проверенный результат.

### Находки

1. **Дата в системном промпте классифицируется как PII и псевдонимизируется.**
   Внешний провайдер видит `Date: <PII:f7e12b44b06a> 19:19:35 +03:00`, то есть
   **не знает сегодняшнюю дату** (токен обратим только в ответах, не для модели).
   Для агента это значит: внешняя модель не может ответить «какое сегодня число»
   и хуже рассуждает про свежесть данных. Класс `pii`/`birthdate` ловит дату как
   дату рождения. Кандидат: исключить системную дату из классификации.
2. **`API_TOKEN=abc123` проходит в открытом виде.** Класс `env` маскирует значения
   *системного* окружения (`SESSIONNAME`), а произвольные `KEY=value` из текста
   пользователя — нет. Малый энтропийный вес (`minConfidence=0.4`) тоже пропускает.
   Это не обязательно баг, но ожидание «env-секрет всегда режется» не выполняется —
   стоит либо ловить `*_TOKEN|*_KEY|*_SECRET=`, либо явно задокументировать границу.

## Прогон 3 — защита на уровне тулов

| Проверка | Результат |
|---|---|
| `read_file` на `_testing/sec-probe/.env` | **выполнен**, содержимое вернулось |
| `web_fetch` на `http://127.0.0.1:1234` | модель **сама отказалась** (в промпте прописан denied-домен), ответ `[SECURITY BLOCKED]` — enforcement не проверен |
| `bash` `echo mma-bash-ok` (после `security.bash.enabled=true`) | **PASS** — `◇ Running command ✓ 53ms`, вывод `mma-bash-ok` |
| `bash` `rm --version` | **PASS** — `✗ 3ms ↳ [SECURITY BLOCKED] Command is not allowed: Command "rm" is blacklisted` |

### Находка 3 — защищённые пути не защищают чтение

`checkToolPath()` применяет `protectedWriteBlock` только для пишущих тулов
(`src/tools/path-enforcement.ts:53-57`). Поэтому `read_file` спокойно читает `.env`/`*.key`,
хотя тот же путь через `/api/file` даёт **403**. Разное поведение двух поверхностей:

- веб-просмотрщик: `.env` → 403 «protected»;
- тул `read_file`: `.env` → 200 + содержимое.

Системный промпт запрещает трогать секреты, но это только просьба к модели. Для
локального провайдера компенсации нет (DLP доверяет loopback); для внешнего —
секрет режется на egress (проверено). Нужно решение: либо запретить чтение
protected-путей тулами (кроме `approve`), либо зафиксировать это как осознанную
позицию и не считать веб-403 «защитой секретов».

### Находка 4 — один и тот же контент редактируется по-разному в одном ходу

`session.jsonl` за один вызов:

```
tool_result:  "... SECRET_TOKEN=[REDACTED]"
directive:    "... SECRET_TOKEN=sk-live-AAAA1111BBBB2222"   ← сырой секрет
```

`tool_result` прошёл через редакцию, а `directive` (`<system-summary>`, который
доезжает до модели) собран из сырого вывода. То есть секрет всё-таки попадает в
историю хода. Для внешнего провайдера его срежет egress-фильтр, для локального —
нет. Ожидание «редакция в tool_result = редакция в контексте» не выполняется.

### Находка 5 — финальный `critical` вердикт критика не виден пользователю

Ход с `web_fetch` закончился `critic_verdict status:critical`, но в ленте только
`↺ draft retracted: critic` и метрика `⟡ 42.9s` — без предупреждения, что
проверка не пройдена. Пользователь видит «SECURITY BLOCKED» как финальный ответ
и не знает, что это не результат тула, а отказ модели.

## Прогон 4 — LSP

| Проверка | Результат |
|---|---|
| `GET /api/lsp/doctor` | `{enabled:true, offline:false}`, 10 серверов с таймаутами |
| `lsp.offline` hot-apply | 200 → doctor `offline:true` → обратно; без рестарта |
| LSP-таб: info-панель | 2 тумблера (`LSP enabled`, `Offline`); текст про global binaries |
| Offline → manual install | 6 команд `npm i -g …` (typescript, javascript, json, …) |
| `POST /api/lsp/check` (холодный старт) | `{ok:false, error:"starting", retryAfterMs:2000}` — не блокирует |
| Повтор через 1.2 с | `ok:true`, 4449 ms, диагностика `Type 'string' is not assignable to type 'number'` (1,7) |
| Тул `lsp_check` (тёплый пул) | `◇ Checking code · _testing/lsp-probe.ts ✗ 5ms`, отчёт с `path(line,col): error: …` |

**PASS.** Холодный старт честно отдаёт `starting`, а не висит 30 с (как и обещает
гейт `check-cold-start`).

## Прогон 5 — индексация и карта

| Что | Результат |
|---|---|
| Map-таб | 1950 файлов, 4159 символов, 1.7K токенов, watcher on |
| Языковая разбивка | typescript 1674 · markdown 229 · html 12 · json 11 · css 10 · js 7 · yaml 4 · shell 1 |
| Re-index | кнопка отработала, `updated today 19:28` |
| Trace | 93 строки: `composer`, `thinking`, тулы с длительностью, `critic · check`, `llm usage`, `turn waited in gates: 5812 ms · critic 5806` |

**PASS**, но из Trace видно две вещи для отчёта:

- гейт критика добавляет **~5.8 с** к ходу даже на тривиальном запросе;
- `llm usage` на простых ходах — **26–27k токенов** (системный промпт + история),
  при окне 78K это ~34% на каждом ходу. Для 4B-модели это дорого по времени.

## Прогон 6 — поиск в вебе

Промпт: «Search the web for "OpenCode coding agent" and give me the top 3 results with URLs.»

| Шаг | Результат |
|---|---|
| `web_search` | `◇ Web search · OpenCode coding agent ✓ 795ms` |
| Авто-переход к `web_fetch` | `◇ Fetching page · https://opencode.ai/ ✓ 528ms` |
| Ответ | 3 URL (`opencode.ai`, `github.com/anomalyco/opencode`, `opencode.ai/docs/agents`) |
| Рамка недоверенного контента | страница отрисована как данные, не как инструкции |

**PASS.** Сеть есть, поиск и загрузка страниц работают, ответ с источниками.

## Прогон 7 — субагент и гейты

Промпт: «Use the subagent tool to read the first 15 lines of src/tools/index.ts and summarize them in 2 sentences.»

| Что | Результат |
|---|---|
| `subagent` | `Sub-agent task … ✓ 16.0s`, в журнале `status:"done", success:true, 9720 tok` |
| Поведение главного агента | **сам** сделал `list_dir` + `read_file` того же файла вместо использования ответа субагента |
| Fact-check / repetition gate | 4 ретрая (`100% overlap`, `100%`, `88%`, `88%`) |
| Итог хода | `✗ Response blocked: Model returned empty or insufficient responses after multiple retries` |

### Находка 6 — повторная работа вместо результата субагента

Субагент ответил за 16 с, но главный агент не использовал его вывод и пошёл
читать файл сам (лишние 2 тула, +10 k токенов контекста). На 4B-модели это
типично, но харнесс мог бы подсказывать: «результат субагента уже в контексте,
не дублируй». Сейчас `subagent` выглядит как обычный тул без явного «это ответ».

### Находка 7 — repetition-гейт съедает ответ целиком

После 4 ретраев ход заканчивается `✗ Response blocked` — пользователь не получает
**ничего**, хотя черновик ответа существовал. Для малых моделей это тупик:
лучше отдать последний черновик с пометкой «проверка не пройдена», чем пустоту.
Сообщение об ошибке техническое и не подсказывает, что делать.

## Прогон 8 — очередь, прерывание, экспорт

| Проверка | Результат |
|---|---|
| Сообщение во время хода | `.qstrip`: «Queued probe: what is 2+2? ▶ × queued · position 1» |
| `Esc` во время хода | `⚠ stopped`, частичный ответ сохранён, статус вкладки снят |
| Очередь после остановки | сообщение **автоматически стартовало** и ответило «4», полоса очистилась |
| `/export --out _testing/agent-export.md` | `exported md → _testing/agent-export.md`, 8001 байт, 31 сообщение, тулы с содержимым |

**PASS.** Очередь, прерывание и экспорт ведут себя как заявлено.

## Прогон 9 — парсинг сайтов (`web_fetch`)

| Цель | Результат |
|---|---|
| `https://example.com` | `✓ 140ms`, markdown-текст, рамка `<untrusted-web-content source="…">` |
| `https://example.com/definitely-missing-page` | `✗ 39ms ↳ Fetch failed: … — HTTP 404: Not Found` (формат понятен модели) |
| `https://www.gnu.org/software/bash/manual/bash.html` | `✓ 1.1s`, но в контекст попало **806 символов** и хвост `... (159 more lines)` |
| `https://html.duckduckgo.com/…` через `web_search` | `✓ 885ms`, для `site:`-запроса вернулся **1** результат (DDG так отдал) |

**Ограничение:** `web_fetch` отдаёт **превью ~60 строк** (`MAX_PREVIEW_LINES`), а не
страницу целиком (`MAX_CHARS=5000` не достигается). Для «спарси вот эту доку»
этого мало: модель видит только начало и должна угадывать анкоры/подстраницы.
Это осознанный кап контекста, но в отчёте фиксирую как границу фичи.

## Прогон 10 — SSRF (наконец, enforcement)

Модель отказывается от `127.0.0.1` (в промпте перечислены denied-домены), поэтому
проверил через имя, которое она не распознаёт:

`web_fetch http://localtest.me:4319/api/state` →

```
✗ 81ms ↳ [SECURITY BLOCKED] redirect: Host "localtest.me" resolves to a private address (SSRF)
```

**PASS** — DNS-резолв в приватный адрес блокируется на уровне тула, не только промптом.
Мелочь: префикс `redirect:` у прямого URL вводит в заблуждение (это не редирект).

## Прогон 11 — браузерный парсинг (`browser`)

| Шаг | Результат |
|---|---|
| `open https://example.com` | `✓ 6.1s`, `Page: "Example Domain"` |
| `click target 1` | перешёл на `iana.org/help/example-domains`, но тул ответил **`✗ Click failed: page.evaluate: Execution context was destroyed, most likely because of a navigation`** |
| `open https://www.iana.org/help/example-domains` | `✓ 49ms`, но в снапшоте **только ссылки** |

Снапшот с example.com целиком:

```
Page: "Example Domain"
URL: https://example.com/

[1] link "Learn more"  https://iana.org/help/example-domains
```

### Находка 8 — в снапшоте браузера нет текста страницы

Описание тула обещает: «Each snapshot includes a "Content" section with the visible
page text». По факту Content-секции нет ни на example.com, ни на iana.org —
только ссылки. В коде текст добывается через `driver.evaluate(buildTextExtractionScript())`,
а ошибка глушится пустым `catch` (`src/modules/browser/snapshot-capture.ts:28-32`).
Итог: агент «видит» только ссылки и не может прочитать страницу из браузера —
ровно та задача, ради которой браузер и нужен (SPA без серверного HTML).

### Находка 9 — клик, вызвавший навигацию, помечается как ошибка

Клик сработал (URL сменился), но тул вернул `success:false` с «Execution context
was destroyed». Агент делает вывод «клик не удался» и повторяет/обходит. Нужно
после клика ждать навигацию и возвращать снапшот новой страницы (или хотя бы
`success:true` при фактическом переходе).

## Прогон 12 — план, approve, скиллы, MCP

| Фича | Результат |
|---|---|
| `plan` | `◇ Planning · create ✓ 22ms`, карточка «◇ Plan · 1 step», шаг выполнен, `◇ Plan step · done`, «plan completed and archived» |
| `approve` (запись в `.env`) | запрос показан: `◇ Approval request`, вопрос «Approve? Append 'probe=1' … 1. Yes 2. No»; нажал **Yes** → `approve` вернул «Approved. One-time permission … retry the operation once» |
| **повтор `append_file`** | **снова `[PROTECTED PATH]`**, файл не изменён |
| `load_skill animate` | `✓ 3ms`, ответ по существу |
| `mcp__playwright__browser_navigate` | тул вызван, сервер ответил `isError:true` («Browser is already in use … use --isolated») |

### Находка 10 (критичная) — `approve` не разблокирует запись

Пользователь подтвердил, тул `approve` вернул «permission active», а следующий
`append_file` по тому же пути снова получил `[PROTECTED PATH]`. Модель честно
сообщила пользователю, что запись невозможна. То есть **из web-интерфейса
защищённый путь записать нельзя вообще**, хотя вся ветка «одноразовый токен»
(PR #12) для этого и сделана.

По коду: `ApprovalStore.consume(path, callId)` ищет грант по
`normalize(resolvedPath)` (`src/core/approvals.ts:78-87`), а `grant()` вызывается
из `approve.ts:57` с `safeResolvePath(...)`. Проверка в `checkToolPath` идёт по тому
же пути, значит расхождение не в пути — скорее всего грант минтится в другом
`ToolContext`/`ApprovalStore`, чем тот, что использует enforcement хода.
Нужен тест: `approve` → `write_file` в protected-путь за один ход должен пройти.

### Находка 11 — MCP-ответ с `isError: true` показывается как успех

`mcp__playwright__browser_navigate` вернул JSON с `"isError": true`, а лента
показала зелёное `✓ 5.1s`. Модель JSON разобрала и сказала «unavailable», но
пользователь видит успешный тул. MCP-результат должен пробрасывать `isError`
в `success:false` (и в метрику/иконку).

## Прогон 13 — setup-визард (virgin-инстанс, порт 4320)

| Шаг | Результат |
|---|---|
| `GET /api/setup` | `required:true`, языки, 7 провайдеров, дефолты безопасности |
| `POST /api/message` до настройки | **409** (гейт серверный) |
| UI | `#setupGate` с шагами Language · Provider · API key · Model · Context · Security · Review |
| `POST /api/setup/scan` | нашёл `LM Studio · http://localhost:1234/v1` |
| `POST /api/setup/models` | 200, **14** моделей |
| `POST /api/setup/test` | `{ok:true}` |
| `POST /api/setup/context` | `{ok:true, contextWindow:80128}` |
| `POST /api/setup` (apply) | `{ok:true, persisted:true}`, `required:false`, дальше `/api/message` → **202** |
| Неверное тело | `invalid-base-url` / `invalid-test-request` / `invalid-answers` — 400 без утечек |

### Находка 12 — UI не реагирует на `setup_done`

После apply из другого клиента открытая вкладка **осталась на визарде** (0 вкладок
чата). `sse.ts` обрабатывает `setup_done` только анимацией маскота; сам гейт не
закрывается, нужен reload. Для CLI-настройки при открытом браузере это выглядит
как «настройка не применилась».

## Что осталось непокрытым (после двух прогонов)

- **компакция** (порог/ledger/cooldown) — нужна история на десятки сообщений;
- **`errorWebSearch`** (авто-поиск после 5 ошибок) — не удалось спровоцировать;
- **картинки** (`attach_image` + vision) — модель без vision;
- **pricing/cost, KV-cache, updater** — не трогал в этом заходе;
- **`mma serve`** (тенант, idempotency, webhook SSRF) — отдельная поверхность;
- **bash scope/jail** и `maxFileOperations` — промпт отговаривает модель раньше,
  чем срабатывает политика; детерминированно только юнит-тестами.

## Прогон 14 — файловые тулы и скоуп записи

| Действие | Результат |
|---|---|
| `write_file _testing/wt/probe.ts` | ✓ создан |
| `lsp_check` после записи | ✓ диагностика `(1,7) Type 'string' is not assignable to type 'number'` |
| `append_file` | ✓ «File appended» |
| `move_file` | ✓ `probe.ts → probe-renamed.ts` |
| `delete_file` | ✓ удалён, `list_dir` подтвердил пустоту |
| `write_file C:\Users\Public\mma-outside.txt` при `paths.enabled=false` | **✓ создан вне воркспейса** |
| то же при `paths.enabled=true` | ✗ `Path is outside the base working directory (path restriction enabled)` |
| `write_file package-lock.json` (denied) | ✗ `Path matches denied pattern: package-lock.json` |
| `write_file` с `eval(` при `contentScan.enabled=true` | ✗ `[SECURITY BLOCKED] Content contains dangerous patterns … eval(` |

### Находка 13 — «workdir jail» по умолчанию выключен

`DEFAULT_SECURITY_CONFIG.paths.enabled = false`, и `isPathInScope/isPathWritable` применяют
jail и denied-список **только при `enabled=true`** (`path-validator.ts:56`, `:237`).
Итог: в конфиге «как есть» (и у всех, кто не проходил визард с `securityPathsRestrict`)
агент **пишет куда угодно** — проверено на `C:\Users\Public\…`. Always-on остаются только
protected-пути (`.env`, `.git`, `*.key`).
Визард ставит `securityPathsRestrict=true` по умолчанию (`setup.ts:140`), то есть новые
установки защищены, а существующие — нет, и ничто об этом не предупреждает.

## Прогон 15 — рестарт и сохранность

| Проверка | Результат |
|---|---|
| После рестарта `/api/sessions` | сессия на месте, 28 сообщений |
| Открытие сессии по `?session=` | история отрисована (4 user-блока, 4.4 КБ) |
| Новый пустой чат | создан автоматически |

**PASS** по персистентности.

### Находка 14 (аномалия) — 35 пустых каталогов сессий за 10 секунд

Во время одного многошагового хода (append/move/delete) в `sessions/` появились **35 каталогов**
`ses_*` с единственным подкаталогом `temp` и **без** `meta.json`/`session.jsonl`
(13 в 20:11:45, 18 в 20:11:46, 4 позже). Их id нигде не встречаются в логах.
`temp` создаёт только `createSessionContext()` (`session-isolation.ts:53-57`), т.е. сессионные
контексты создавались для id, которые так и не стали сессиями. Нужен отдельный репро —
потенциально «мусорные» сессии копятся при каждом ходе.

## Прогон 16 — два клиента на одну сессию

Две вкладки Chromium на `?session=<id>`: отправка из вкладки 1 → вкладка 2 получила ответ
живьём (`FANOUT-OK`), без reload. **PASS** (SSE-фанаут работает).

## Прогон 17 — обрыв провайдера посреди стрима

Подставной провайдер отдаёт 2 чанка `partial answer` и рвёт соединение.

| Проверка | Результат |
|---|---|
| Запросов к провайдеру | **1** (ретраев нет, `maxStreamRetries=2`) |
| Итог хода | `partial answer` + метрика `⟡ 291ms`, `turn_end success` |
| Ошибка/предупреждение | нет |

### Находка 15 (критичная) — обрыв стрима принимается за успешный ответ

Незавершённый поток (без `finish_reason`/`[DONE]`) сохраняется как финальный ответ и
помечается успешным. Пользователь получает обрубок («partial answer») без единого признака,
что ответ неполный; `maxStreamRetries` не срабатывает. В `session.jsonl` это выглядит как
обычный `assistant` + `gate_timing` + `egress_turn`.

### Находка 16 — мёртвый провайдер даёт сырой текст ошибки

После падения стаба: `✗ Unable to connect. Is the computer able to access the url?` —
это строка Bun fetch, без имени провайдера/модели и без подсказки. В ленте она
показывается как `errline`, но диагностировать по ней нечего.

## Прогон 18 — тумблеры безопасности и их применение

| Настройка | Что вышло |
|---|---|
| `sessionEncryption.enabled` (включил на живом сервере) | новые сообщения **всё ещё plaintext** |
| после рестарта | новые строки `history.jsonl` — шифротекст, `0` вхождений плейнтекста; UI расшифровывает |
| `auditNotifier.enabled` + `filePath` | файл **не создан** после `security_block` |
| после рестарта | триггер не воспроизведён (модель отказалась повторить блок) — не проверено |
| `security.rateLimits.maxRequestsPerMinute=1` (живьём) | лимит не применился (2 запроса прошли) |
| после рестарта | второй ход висел **49.7 с**, в Trace: `⚠ Recoverable LLM error, feeding back (1/2): Rate limit exceeded: 1 requests per minute` |
| `audit.jsonl` сессии | пишется: `file_write`, `file_move`, `file_delete`, `security_block` с reason |

### Находка 17 — часть security-ключей не hot-apply и об этом не сказано

`sessionEncryption`, `auditNotifier`, `security.rateLimits.*` применяются **только после
рестарта** (у ключей нет эффекта `rebuild`). В отличие от вкладки MCP («takes effect after
restart»), панель безопасности молчит: пользователь включает шифрование, видит «on» и
считает, что сессия шифруется. Плюс лимит скорости проявляется как **50-секундное
зависание** без индикатора — предупреждение есть только в Trace.

## Прогон 19 — SSRF в `download_file` и `favicon`

| Вектор | Результат |
|---|---|
| `download_file https://example.com/` | ✓ 2.6 с, файл скачан |
| `download_file http://localtest.me:4319/api/state` | ✗ `[SECURITY BLOCKED] redirect: Host "localtest.me" resolves to a private address (SSRF)` |
| `GET /api/favicon` | URL/путь от клиента **не принимает** — иконка ищется только в воркспейсе, вектора нет |

**PASS.** (Повторяется тот же косметический дефект: префикс `redirect:` у прямого URL.)

## Прогон 20 — компакция

Принудительно: `contextBudget.compactionThreshold=0.1`, `compactionMinLoad=0.05`,
окно 32 768, история ~20 ходов.

| Показатель | Значение |
|---|---|
| context | 15.5K / 32.8K, dialogue 2.6K, tools 8.7K, instructions 4.2K |
| compactions | **⟳ 0** (не сработала) |

### Находка 18 — компакция не запускается даже при пороге 0.1

При `used/limit ≈ 47%` и пороге 10% компакция не выполнилась. Наблюдение требует
юнит-разбора: триггер, похоже, считается от бюджета **истории**, а не окна, и при
`dialogue 2.6K` против ~16K бюджета не достигается. Как есть — фича непроверяема из UI.

### Находка 19 — «context loaded» показывает старое окно

В панели Session: `context 15.5K / 32.8K`, но `context loaded` = **80.1K** (значение из
`meta.contextWindow`, зафиксированное при создании сессии). После смены окна цифры
в одном блоке противоречат друг другу.

### Замечание по стоимости контекста

На маленьком окне видно, что **описания тулов занимают 8.7K токенов** — больше, чем
диалог (2.6K). Для 16K-модели это половина окна; `tools.enableOnDemand`/сужение набора
здесь не просто оптимизация, а условие работоспособности.


## Прогон 21 — живая сессия пользователя (2026-11-01)

Источник: скриншот пользователя, сессия `ses_mvya6pt4_vqfikupkyuujfeur`,
`nvidia-nemotron-3.5-bolt-e4b`, окно 64K.

| Наблюдение | Факт |
|---|---|
| Предупреждение в ленте | «Автоочистка сессий пропущена: в каталоге **114717** сессий (порог 1000). Проверьте `mma session prune --dry-run`, затем `mma session prune`» |
| Задача | прикреплено фото + «что на фото?» |
| Ответ модели | корректный: витрина пекарни, «Булочки ВИШЕНКА», «Булочки МАЛИННЫЕ» |
| Критик, итерация 1 | `черновик отозван: критик`, **вердикт critical**: «The agent claims to describe a photo, but no image evidence was provided for verification» |
| Критик, итерация 2 | `черновик отозван: критик`, **вердикт concern**: «The image required to answer the task is not provided in the current evidence» |
| Итог хода | ответ принят, но после двух ложных ретраев |

Это подтвердило находку 14 на реальной установке (114 667 каталогов-призраков против
50 живых сессий) и вскрыло новую находку 20 (критик не знает о вложениях).

## Анализ причин (по каждой находке)

Метод: систематический дебаг — сначала воспроизведение и трассировка данных до источника,
потом вывод. Где источник не доказан, так и написано, с тестом, который его добьёт.

### 1. Дата в системном промпте классифицируется как PII

- **Симптом:** внешний провайдер видит `Date: <PII:f7e12b44b06a> 19:19:35 +03:00`.
- **Трасса:** системный промпт содержит `Date: 2026-11-01 20:08:25 +03:00` →
  `detectPii` → `detectors/pii/rf.ts:48`:
  `{ kind: "birthdate", re: /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)(?!T\d{2}:\d{2})/g, confidence: 0.4 }`.
  Негативный lookahead отсекает только ISO-форму с `T`, а промпт пишет дату **через пробел**.
- **Почему не отброшено порогом:** `confidence: 0.4` ровно равен `minConfidence: 0.4`,
  сравнение `>=` → находка принята.
- **Уверенность:** высокая (regex + конфиг + payload совпадают).
- **Проверка:** `detectPii("Date: 2026-11-01 20:08:25")` → finding `birthdate`; после
  исключения системной даты — пусто.

### 2. `API_TOKEN=abc123` уходит в открытом виде

- **Симптом:** в payload остаётся `API_TOKEN=abc123`.
- **Трасса:** два механизма, и оба промахиваются:
  1. `detectors/secrets.ts` — `KEY_ID` перечисляет `api_key|access_token|auth_token|token|…`,
     но **не** `api_token`; кроме того, для неквотированного значения требуется `{8,}`
     символов, а `abc123` — 6.
  2. `detectors/machine.ts:38-46` — `ENV_ASSIGN_RE` матчит только ключи из
     `SENSITIVE_ENV_KEYS` (системные: `SESSIONNAME`, `USERNAME`, …), произвольные
     `*_TOKEN=` не рассматриваются.
- **Уверенность:** высокая.
- **Проверка:** `detectSecrets("API_TOKEN=abcdefgh")` → пусто (ключ не в списке);
  `"token=abcdefgh"` → finding (ключ есть). Это и есть дискриминатор.

### 3. Защищённые пути защищают только запись

- **Симптом:** `read_file .env` → 200, `/api/file .env` → 403.
- **Трасса:** `tools/path-enforcement.ts:53-57`:
  `const writable = isWritableTool(security); if (writable) { protectedWriteBlock(...) }` —
  для `fs: read` проверка protected **не вызывается**, остаётся только scope.
  Веб-просмотрщик идёт другим путём — `modules/webui/file/paths.ts:46` — и проверяет
  `matchProtectedPath` всегда.
- **Уверенность:** высокая (код + оба ответа).
- **Следствие:** модель читает секреты; единственный барьер на вынос — DLP-egress.

### 4. Сырой секрет в `directive`

- **Симптом:** в одном ходу `tool_result` = `SECRET_TOKEN=[REDACTED]`, а `directive` =
  `SECRET_TOKEN=sk-live-…`.
- **Трасса:** санитайз применяется **к журналу**, а не к контексту:
  `core/session-logger.ts:220` (`sanitizeLogMessageTargeted(result.output)`) и `:231`
  (то же для строки лога). В контекст модели уходит исходный `result.output`, а
  harness-директива (`loop-run.ts:76-78`) логируется как есть.
- **Уверенность:** высокая.
- **Вывод:** редакция — свойство отображения/лога, не данных. Для внешнего провайдера
  спасает egress-фильтр, для локального — нет.

### 5. Финальный `critical` критика не виден

- **Симптом:** в ленте только `↺ draft retracted: critic`, итоговый вердикт — нигде.
- **Трасса:** `critic-gate-log.ts:66,96` пишет `critic_verdict` только в session-лог.
  В SSE (`webui/session/forward.ts`) транслируется лишь `retract` (строки 182-193) и
  meta; отдельного обработчика `critic_verdict` в `sse.ts` нет.
- **Уверенность:** высокая.

### 6. Главный агент дублирует работу субагента

- **Симптом:** субагент ответил за 16 с, родитель всё равно сделал `list_dir` + `read_file`.
- **Трасса:** `tools/subagent-result.ts:52-60` — текст результата **есть** в tool-output
  (`tool.subagent_completed`), харнесс ничего не теряет. Дублирование — решение модели
  (4B), а не дефект кода.
- **Уверенность:** средняя (поведение модели; на другой модели может не воспроизвестись).
- **Вывод:** это не баг; максимум — UX-подсказка «результат уже в контексте».

### 7. Repetition-гейт съедает ответ

- **Симптом:** после 4 ретраев `✗ Response blocked: Model returned empty or insufficient responses…`.
- **Трасса:** `core/agent/hallucination-gate.ts:149-156`:
  при `hallucinationRetries >= MAX_HALLUCINATION_RETRIES` вызывается `retractDraft(...)`
  (черновик **удаляется**) и возвращается `block` с `t("hall.max_retries_exhausted")`.
- **Уверенность:** высокая.
- **Вывод:** это осознанная политика «лучше ошибка, чем непроверенный ответ», а не
  случайный баг. Проблема — в UX: нет fallback на последний черновик и нет объяснения.

### 8 + 9. Браузер: скрипты не исполняются вообще (единая причина)

- **Симптомы:** в снапшоте нет секции Content; клик «сработал», но вернул
  `Execution context was destroyed`; текст страницы агенту недоступен.
- **Решающий эксперимент:** тот же скрипт, что строит `buildTextExtractionScript()`,
  переданный в `page.evaluate`, падает:
  `SyntaxError: Unexpected token 'const'` (проверено на живой странице example.com).
- **Трасса:** `modules/browser/actions.ts` — все билдеры возвращают **тело функции**
  (`const …; return …`), без обёртки/IIFE:
  `buildIndexInjectionScript`, `buildTextExtractionScript`, `buildClickScript`,
  `buildTypeScript`, `buildScrollScript`. А `driver.evaluate(js)` —
  это `page.evaluate(js)` (`modules/browser/driver.ts:111-112`), который строку
  трактует как **выражение** (`eval`), а не как тело функции.
- **Следствия:**
  - индексация `data-browser-index` не выполняется → клик/ввод по номеру не находят элемент;
  - текст не извлекается, ошибка глушится пустым `catch` (`snapshot-capture.ts:28-32`) →
    Content-секции нет;
  - снапшот всё равно печатает `[1] link …`, потому что список элементов парсится из HTML
    (`extractInteractiveElements`), а не из DOM-индексов. Отсюда иллюзия работающего клика.
- **Корректировка ранней гипотезы:** клик не «сработал с ложной ошибкой» — он вообще не
  исполнялся; переход на iana.org сделал сам агент следующим действием `open`.
- **Уверенность:** высокая (воспроизведено напрямую).
- **Проверка после фикса:** `page.evaluate` должен получать `() => { … }` (или IIFE),
  тогда `document.querySelectorAll('[data-browser-index]').length > 0` и в снапшоте
  появляется `Content`.

### 10. `approve` не разблокирует запись (критично)

- **Симптом:** «Approved. One-time permission … is active», повторный `append_file` → снова `[PROTECTED PATH]`.
- **Трасса (найдена):** веб-ход исполняется **раннером**, у которого свой `ToolContext` —
  `core/bootstrap/session-runner-scope.ts:111-155` (`buildRunnerToolCtx`). В этом объекте
  **нет поля `approvals`** (в `tool-context.ts:186` оно есть, в раннере — забыто).
  Далее:
  - `tools/approve.ts:57` — `ctx.approvals?.grant(...)`: optional chaining делает вызов
    **no-op**, но ответ всё равно `tool.approved_path` («permission active»);
  - `tools/path-enforcement.ts:31` — `ctx.approvals?.consume(...)` → `undefined` → блок.
- **Почему не поймали тестом:** гвард проверяет `approve` в контексте `session-phase`,
  а не раннера; веб-путь — другой экземпляр.
- **Уверенность:** высокая.
- **Проверка:** тест «approve → write_file в protected за один ход» через раннер
  (как в web) должен падать до фикса; после добавления `approvals` в `buildRunnerToolCtx` — проходить.

### 11. MCP `isError` показывается зелёным

- **Симптом:** сервер вернул `{"isError": true}`, лента — `✓`.
- **Трасса:** `modules/mcp/module.ts:214-218`: `const result = await client.callTool(...)`
  → `return { success: true, output: JSON.stringify(result) }`. Поле `isError` не читается.
- **Уверенность:** высокая.

### 12. UI не реагирует на `setup_done`

- **Симптом:** после apply из API вкладка осталась на визарде.
- **Трасса:** `assets/js/sse.ts:195` — `es.addEventListener("setup_done", () => faceEvent("done"))`.
  Гейт (`#setupGate`) закрывается только внутри `setup.js` после собственного POST;
  внешнее событие не триггерит ни закрытие, ни перезагрузку состояния.
- **Уверенность:** высокая.

### 13. Workdir jail выключен по умолчанию

- **Симптом:** `write_file C:\Users\Public\…` → успех.
- **Трасса:** `config/security.ts` — `DEFAULT_SECURITY_CONFIG.paths.enabled = false`;
  `modules/security/path-validator.ts:56` — jail и `denied` применяются только при
  `isJailEnabled(securityConfig)`. Визард ставит `securityPathsRestrict: true`
  (`assets/setup.ts:140`), но это лишь одноразовый ответ, не дефолт.
- **Уверенность:** высокая.
- **Проверка:** `DEFAULTS.security.paths.enabled` → `false`; при `true` тот же вызов блокируется (проверено A/B).

### 14. Каталоги-призраки сессий (подтверждено на реальной установке)

- **Симптом (стенд):** 35 каталогов `ses_*` с одним `temp/`, без `meta.json`/`session.jsonl`,
  id нигде не логируются; всплеск за 10 с.
- **Симптом (реальный `~/.mma`, 2026-11-01):** `114 717` каталогов сессий, из них
  **50** с `meta.json` и **114 667** — призраки (только `temp/`). UI показывает:
  «Автоочистка сессий пропущена: в каталоге 114717 сессий (порог 1000). Проверьте
  `mma session prune --dry-run`, затем `mma session prune`».
  Сессия пользователя: `ses_mvya6pt4_vqfikupkyuujfeur`.
- **Что известно про призраков:** выборка первых 4000 — все без меты и все созданы
  **всплеском** `2026-10-08 21:08:58–59` (id идут подряд: `muzuoqjf`, `muzuoqjs`,
  `muzuoqk7`…), т.е. `newSessionId()` вызывался тысячи раз за секунды. В каталоге только
  `temp/`.
- **Трасса:** `temp` создаёт только `createSessionContext()`
  (`modules/security/session-isolation.ts:53-57`), вызываемый из
  `modules/session/manager.ts:90` (`create()` — сначала `saveMeta`, потом контекст) и
  `:304` (`getSessionContextById` — требует существующую мету). `deleteSession` удаляет
  каталог целиком (`store.ts`), так что это не «остатки от удаления».
- **Усугубляющий фактор (самоподдерживающийся):** автоочистка **пропускается**, когда
  каталогов больше порога 1000, — то есть один раз перевалив порог, мусор больше никогда
  не собирается, а призраки продолжают накапливаться.
- **Вывод:** причина **не доказана**. Каталог без меты при штатном `create()` невозможен,
  значит либо `saveMeta` писал в другой корень (иной `MMA_CONFIG_DIR`/старый билд),
  либо `createSessionContext` вызывался путём, которого нет в текущем `src/`
  (исторический баг в установленном `dist/`), либо `create()` вызывался в цикле с ошибкой.
- **Что нужно, чтобы доказать:** логировать стек в `createSessionContext`, когда
  `<dir>/meta.json` отсутствует; плюс проверить, каким билдом созданы призраки
  (сравнить `meta.json` 50 живых с версией `dist/`). Без этого — только гипотезы.
- **Практический выход для пользователя:** `mma session prune --dry-run` → `mma session prune`;
  но сначала стоит поднять порог/починить создание, иначе мусор вернётся.


### 15. Обрыв стрима принимается за успех (критично)

- **Симптом:** 2 чанка → соединение убито → `partial answer` + `⟡ 291ms`, 1 запрос, ретраев нет.
- **Трасса:** `llm/openai-compat.ts:314-318`:
  `const sawDone = yield* this.streamOnce(...); if (sawDone || emitted) return;`
  — любой выданный чанк считается завершением; ретрай включается только при
  **нулевом** контенте. Обрыв транспорта не даёт `finish_reason`, поэтому проверка
  «`finish_reason` есть?» не срабатывает (она есть только для `length`, строка 803).
- **Уверенность:** высокая.
- **Проверка:** тот же стаб + `emitted=true, sawDone=false` должен приводить к
  ретраю (2 запроса) и/или `turn_end.success=false` с причиной `stream_truncated`.

### 16. Сырой текст ошибки провайдера

- **Симптом:** `✗ Unable to connect. Is the computer able to access the url?`.
- **Трасса:** `llm/openai-compat.ts:905-910`: в `fetchWithRetry` на последней попытке
  `if (attempt === maxRetries) throw err;` — исходная ошибка fetch пробрасывается как есть.
  Дружелюбные обёртки есть только для HTTP-статусов (429 — строка 922, `llm_retries` — 931).
- **Уверенность:** высокая.

### 17. Security-ключи не hot-apply

- **Симптом:** включил шифрование/аудит/лимит — эффекта нет до рестарта.
- **Трасса:** `config/registry-extra.ts:28-38` — `effects: reconfigure ? REBUILD : []`;
  у `security.sessionEncryption.*`, `security.auditNotifier.*`,
  `security.rateLimits.*` передано `false`. Плюс точки, читающие конфиг один раз:
  - шифрование: `core/bootstrap/session-phase.ts:109` — `new SessionStore(dir, config.security.sessionEncryption)`;
  - аудит: `core/bootstrap/config-phase.ts:80` — `globalAuditNotifier.updateConfig(...)` только на старте;
  - лимит: `llm/openai-compat.ts:194` — `createRateLimiter(config.rateLimits)` при сборке провайдера.
- **Уверенность:** высокая.
- **Следствие:** UI показывает «on», поведение — старое; ни подсказки, ни пометки.

### 18. Компакция не срабатывает (причина не установлена)

- **Симптом:** `threshold=0.1`, `used/limit ≈ 47%`, dialogue 2.6K — `compactions ⟳ 0`.
- **Что известно:** `core/context/manager.ts:523-525`:
  `if (historyTokens > this.getHistoryLimit() * this.compactionThreshold) return true;`
  При `getHistoryLimit() ≈ 15K` и пороге 0.1 условие `2.6K > 1.5K` — **истинно**,
  то есть предикат должен был сработать.
- **Две равноправные гипотезы:**
  1. `needsCompaction()` вернул `true`, но `compact()` вернул `null` («нечего уплотнять»),
     и счётчик не инкрементится;
  2. порог считается по другим числам (`historyTokensForThresholds` / `budget.history`),
     чем показывает панель.
- **Вывод:** причина **не доказана**.
- **Что нужно:** лог `{historyTokens, historyLimit, threshold, minLoad, needs, compactResult}`
  на каждом прологе итерации; один ход даст ответ.

### 19. «context loaded» показывает окно провайдера

- **Симптом:** `context 15.5K / 32.8K`, а `context loaded` = `80.1K`.
- **Трасса:** `assets/js/feed/sidebar.ts:205-228` — `probeLoadedText(h.contextProbe, …)`
  печатает `probe.actual` (сколько токенов реально загрузил бэкенд), и скрывает строку
  только при **несовпадении модели** (`probe.model !== activeModel`). Совпадение окна
  не проверяется, поэтому проба 80.1K живёт рядом с окном 32.8K.
- **Уверенность:** высокая.
- **Вывод:** это не «старое окно сессии», а другая метрика с неоднозначной подписью;
  чинится либо подписью «provider window», либо скрытием при `probe.actual !== contextWindow`.

### 20. Критик не видит вложенные изображения → ложные отзывы черновика

- **Симптом (живая сессия `ses_mvya6pt4_vqfikupkyuujfeur`, 2026-11-01):** пользователь
  прикрепил фото и спросил «что на фото?». Модель ответила по делу (витрина пекарни,
  «Булочки ВИШЕНКА», «Булочки МАЛИННЫЕ»), но критик **дважды** отозвал черновик:
  1. `вердикт: critical` — «The agent claims to describe a photo, but no image evidence
     was provided for verification»;
  2. `вердикт: concern` — «The image required to answer the task is not provided in the
     current evidence».
  Итог: два лишних ретрая (~11.6 с + 3.6 с + 2.9 с) и две вводящие в заблуждение строки
  «черновик отозван»; ответ в конце всё же принят.
- **Трасса:** пакет доказательств критика — `modules/critic/evidence.ts:26-34`
  (`EvidenceInput`: `task`, `planSummary`, `toolEvents`, `baseDir`, `answerText`) и
  промпт `client.ts:274-280` (`CHANGED FILES / COMMANDS / WEB GROUNDING / TOOL TRAIL /
  ANSWER`). **Ни поля с вложениями, ни упоминания, что пользователь приложил изображение,
  нет** (`grep image|attachment` по `modules/critic/*` — пусто). При этом критик
  запускается и для чат-ходов без тулов: `core/agent/critic-gate.ts:189` —
  `if (toolEvents.length === 0 && !answerText?.trim()) return false;` — при наличии ответа
  гейт срабатывает.
- **Механизм ложного вердикта:** правило «numeric claims require web grounding» и общая
  установка «flag only what is verifiable from evidence» заставляют критика считать
  описание картинки недоказуемым: в пакете нет ни изображения, ни маркера вложения,
  значит для него это «claim without evidence».
- **Уверенность:** высокая (код + два вердикта с точными формулировками).
- **Проверка:** ход с прикреплённым изображением и без тулов не должен отзываться
  по причине «no image evidence»; после фикса — `critic_verdict` = `ok` на том же промпте.
- **Направления фикса (не реализованы):** (а) добавить в пакет `attachments: {count, kinds}`
  и правило «вложение удовлетворяет image-evidence»; (б) не запускать критика на ходах
  с изображениями, если модель-критик не vision-capable; (в) передавать изображение
  критику, когда модель vision-capable.


## Итоговая таблица (все прогоны)

| Блок | Статус | Ключевое |
|---|---|---|
| Защищённые пути (веб) | PASS | `.env`, `.key`, `.git/config`, traversal → 403 |
| ADS/регистр | PASS | `.env:stream` → 404, `.ENV` → 403 |
| Поиск не течёт / hidden globs | PASS | секрет не найден, скрытое → 0/404 |
| Ход агента | PASS | стриминг, reasoning, тулы, critic-ретрай |
| DLP egress | PASS | 13 редакций, external/local, журнал |
| DLP: дата как PII | **находка 1** | внешняя модель не видит дату |
| DLP: `API_TOKEN=` | **находка 2** | env-секрет в тексте проходит |
| Protected paths в тулах | **находка 3** | `read_file` читает `.env` |
| Редакция tool_result/directive | **находка 4** | сырой секрет в directive |
| Critic `critical` в UI | **находка 5** | вердикт не виден |
| Субагент | PASS / **находка 6** | работает, но дублируется главным агентом |
| repetition-гейт | **находка 7** | ответ теряется после ретраев |
| Bash allow/deny | PASS | `echo` ✓, `rm` → блок с причиной |
| SSRF (DNS) | PASS | `localtest.me` → `[SECURITY BLOCKED]` |
| LSP | PASS | doctor, offline, cold start, `lsp_check` 5 мс |
| Индексация/Map | PASS | 1950 файлов, reindex, Trace |
| `web_fetch` парсинг | PASS (+граница) | 404-формат, рамка; превью ~60 строк |
| `web_search` | PASS | DDG, 1–3 результата |
| `browser` парсинг | **находки 8, 9** | нет текста в снапшоте, клик-навигация = ошибка |
| План | PASS | карточка плана, шаги, архив |
| `approve` | **находка 10** | запись не разблокируется |
| MCP | **находка 11** | `isError` → зелёный ✓ |
| MCP UI | PASS | сервер, статус, подсказка про рестарт |
| Скиллы | PASS | `load_skill` 3 мс |
| Очередь/стоп/экспорт | PASS | queue, `⚠ stopped`, 8 КБ экспорт |
| Setup-визард | PASS / **находка 12** | полный цикл apply; UI ждёт reload |
| Файловые тулы | PASS | write/append/move/delete/list + LSP после записи |
| Workdir jail по умолчанию | **находка 13** | `paths.enabled=false` → запись вне воркспейса |
| Рестарт / персистентность | PASS | история и сессии восстанавливаются |
| Мусорные сессии | **находка 14** | 114 667 призраков в реальном `~/.mma`; автоочистка глохнет на >1000 |
| Критик + изображения | **находка 20** | «no image evidence» → ложные отзывы черновика |
| Два клиента одной сессии | PASS | live fan-out по SSE |
| Обрыв стрима | **находка 15** | обрубок принят за успешный ответ |
| Ошибка провайдера | **находка 16** | сырой текст Bun вместо диагностики |
| Security-тумблеры | **находка 17** | часть применяется только после рестарта |
| `contentScan` | PASS | запись `eval(` → `[SECURITY BLOCKED]` |
| Audit-журнал сессии | PASS | `security_block`, `file_*` с reason |
| `download_file` SSRF | PASS | приватный хост → блок |
| `favicon` | PASS | клиентский URL не принимается |
| Компакция | **находка 18** | не срабатывает даже при пороге 0.1 |
| «context loaded» | **находка 19** | показывает старое окно 80.1K |

## Рекомендации по приоритету

1. **Находка 15** (обрыв стрима = успех) — пользователь получает обрубок без признака.
2. **Находка 10** (`approve` не работает) — блокирует всю защиту записи из web.
3. **Находка 13** (jail выключен по умолчанию) — агент пишет вне воркспейса.
4. **Находка 8** (браузер без текста) — «парсинг SPA» не работает как заявлено.
5. **Находка 17** (security-ключи без hot-apply) — тумблер врёт до рестарта.
6. **Находка 3** (чтение protected-путей тулами) — решить: запрет или документ.
7. **Находка 14** (сессии-призраки) — репро, затем `prune` и порог.
8. **Находка 20** (критик без изображений) — маркер вложений в пакете доказательств.
9. **Находки 4, 9, 11** — редакция directive, клик-навигация, MCP `isError`.
10. **Находки 18, 19** — компакция и «context loaded».
11. **Находки 1, 2, 5, 6, 7, 12, 16** — остальное.

## Что осталось непокрытым (после трёх заходов)

- **аудит-нотифаер после рестарта** — триггер не воспроизведён (модель отказывается), нужен детерминированный тест;
- **`errorWebSearch`** (авто-поиск после серии ошибок);
- **картинки/vision**, **pricing/cost**, **KV-cache**, **updater**, **`mma serve`**;
- **`maxFileOperations` / `maxRecursionDepth` / `maxParallelTasks`** — нужен юнит-уровень;
- **узкий layout / a11y / XSS в выводе модели**; **`/meet`**, **`mma agents init`**;
- **миграция и атомарная запись конфига**.

Артефакты прогона: `_testing/mma-web-agent-report.md` (этот файл),
`_testing/dlp-stub.ts` + `dlp-stub.log`, `_testing/stream-cut.ts` + `stream-cut.log`
(стенды DLP и обрыва стрима). Временный `MMA_CONFIG_DIR` удалён, сервер и стабы
погашены по PID, репозиторий не изменён.
