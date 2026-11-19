# LSP Doctor & Locked-Down Networks

Дата: 2026-10-02
Статус: approved
Ветка: `feat/lsp-doctor`

## 1. Проблема и цель

**LSP — Language Server Protocol** (протокол языковых серверов): стандарт общения
редактора с сервером, который отдаёт настоящие ошибки/предупреждения компилятора
(тот же движок, что подсвечивает ошибки в VS Code). В MMA один клиент
(`src/modules/lsp/`) гоняет серверы по языкам и подмешивает их диагностики в
контекст модели; для пользователя это «статическая проверка кода» без сборки.

Когда LSP не работает (офисный/корпоративный ПК, запертый npm-реестр, нет
интернета, нет бинарника в PATH), пользователь **не может понять почему**:
причина оседает в `app.jsonl` (`FileOnlyLogger` пишет `logSilent`), в чат идёт
только невнятное `[LSP check failed]`, а `lsp_check` молча деградирует. Нет
различия между «нет бинарника», «нет доступа к реестру», «сервер упал» и
«таймаут»; нет команды, которая бы показала причину.

**Цель:** сделать причину неисправности LSP видимой и действуемой:

1. Команда **`/lsp doctor`** — по каждому серверу: применимость, включённость,
   найден ли бинарник, пойдёт ли через npx, реальная ошибка и **класс причины**
   с подсказкой, что делать.
2. **Классификация ошибок** (`binary-missing` / `network` / `offline` /
   `timeout` / `spawn-failed` / `server-error`) — используется и в doctor, и в
   `[LSP check failed]`-подсказке для модели (одна actionable строка).
3. **Офлайн-режим `MMA_LSP_OFFLINE=1`** — не ходить в сеть вообще: использовать
   только бинарники из PATH; если npx понадобился бы — понятная ошибка
   `offline: <binary> not found in PATH`.
4. Документация «LSP в закрытой сети» в `docs/agents/tools.md`.

## 2. Non-goals

- Не добавляем ключи `lsp.*` в реестр `/config`. `LspModule` при bootstrap
  копирует `config.lsp` (`{...DEFAULT_LSP_CONFIG, ...config}`), поэтому live-
  правка `config.lsp.enabled` не долетела бы до работающего модуля без отдельного
  reconfigure-механизма. Правка остаётся ручной (`~/.mma/config.json`), а
  `/lsp doctor` показывает текущее состояние и как чинить. Реестр — отдельная
  задача.
- Не добавляем `/lsp` в web-команды (браузерные slash-команды не включают LSP;
  терминальная команда покрывает кейс эксплуатации).
- Не меняем протокол диагностик (`checkFile`, `publishDiagnostics`) и не
  трогаем `startup-check.ts`/`probe.ts` (баннер REPL остаётся).
- Не пытаемся автоматически ставить серверы из внутреннего зеркала — только
  сообщаем, как это сделать (PATH, `command`, `env.npm_config_registry`).

## 3. Диагностика: модель данных

Новый модуль `src/modules/lsp/diagnose.ts` (чистый, без состояния):

```ts
export type LspFailureReason =
  | "ok"              // initialize прошёл
  | "disabled"        // глобально/по-серверно выключен
  | "not-applicable"  // в проекте нет файлов этого языка
  | "binary-missing"  // бинарника нет в PATH и не npx-ный путь
  | "offline"         // MMA_LSP_OFFLINE и понадобился npx
  | "network"         // npx: докачка/инициализация не прошла (реестр недоступен?)
  | "timeout"         // initialize timeout при доступном бинарнике
  | "spawn-failed"    // ENOENT/EINVAL/прочий провал spawn
  | "server-error"    // иные ошибки протокола/сервера
  | "deadline";       // не успели до общего дедлайна doctor

export interface LspServerDiagnosis {
  language: string;            // ключ сервера (typescript, css, …)
  command: string;             // исходная команда из конфига
  args: string[];              // исходные args
  enabled: boolean;            // server.enabled !== false
  applicable: boolean;         // есть файлы этого языка
  autoInstall: boolean;        // server.autoInstall !== false
  effectiveCommand?: string;   // после npx→глобальный бинарник
  binaryName?: string | null;  // распознанное имя бинарника (npx-layout) или command
  binaryOnPath?: boolean;
  useNpxFallback?: boolean;    // реально уйдёт в npx
  probed: boolean;             // spawn+initialize запускался
  ok: boolean;
  reason: LspFailureReason;
  error?: string;              // сырая ошибка (для doctor --verbose/логов)
  durationMs?: number;
}

export interface LspDiagnosis {
  enabled: boolean;
  offline: boolean;
  projectRoot: string;
  servers: LspServerDiagnosis[];
}

export async function diagnoseLspServers(
  config: LspConfig,
  baseDir: string,
  deps?: {
    client?: LspClient;
    timeoutMs?: number;          // кап таймаута сервера (по умолчанию 20с)
    deadlineMs?: number;         // общий дедлайн (по умолчанию 45с)
    collectFiles?: (baseDir: string, config: LspConfig) => Promise<string[]>;
    findOnPath?: (name: string) => string | null;
    offline?: boolean;           // override MMA_LSP_OFFLINE
    logger?: LspClientLogger;
  },
): Promise<LspDiagnosis>;
```

**Алгоритм:**
1. `files = collectCheckFiles(baseDir, config)`; `applicable = Set(getServerKeyForFile(f))`.
2. Для каждого `servers[key]`:
   - `!config.enabled || server.enabled === false` → `disabled`, не пробим.
   - `!applicable` → `not-applicable`, не пробим.
   - резолв запуска (`resolveNpxLaunch` для `npx`, иначе `findOnPath(command)`);
   - не-`npx` и `autoInstall === false` без бинарника → `binary-missing`, не пробим;
   - `offline && useNpxFallback` → `offline`, не пробим (не ходим в сеть);
   - иначе `client.probe(server, projectRoot, min(server.timeout ?? config.timeout, cap))`;
     `ok` → `ok`; исключение → `classifyLspError(msg, { npxFallback })`.
3. Сервера, не успевшие до общего дедлайна → `deadline` (`probed:false`).
4. Пробим **последовательно** (диагностика — ручное действие; параллельная
   проба на холодном npx-кэше дерётся за лок, см. `probe.ts`), с дедлайном.

`classifyLspError(message, { npxFallback? })`:
- `/not found in PATH/` → `binary-missing`
- `/MMA_LSP_OFFLINE|auto-install is disabled/` → `offline`
- `/ENOENT|EINVAL|spawn/` → `spawn-failed`
- `/timeout/` и `npxFallback` → `network`; `/timeout/` → `timeout`
- иначе → `server-error`

## 4. Офлайн-режим и резолв запуска

Новый модуль `src/modules/lsp/resolve.ts` — вынос приватной логики
`LspClient.startServer` (npx→глобальный бинарник) в чистые функции, чтобы
doctor и клиент считали одинаково:

```ts
export function extractBinaryFromNpxArgs(args: string[]): string | null;
export function isPackageVersion(s: string): boolean;
export function findOnPath(name: string): string | null;   // where/which, 3с
export interface NpxLaunch {
  command: string;
  args: string[];
  binaryName: string | null;
  binaryOnPath: boolean;
  useNpxFallback: boolean;
}
export function resolveNpxLaunch(
  command: string,
  args: string[],
  probe?: (name: string) => string | null,
): NpxLaunch;
export function isOfflineLsp(): boolean;  // readEnv("LSP_OFFLINE") truthy
```

- `resolveNpxLaunch` — только для `command === "npx"`; при строгом layout
  `[--yes] [--package X]… <binary> --stdio` ищет `<binary>` в PATH и вырезает
  npx-обвязку; иначе возвращает `npx` как есть. Поведение 1:1 текущему.
- `client.startServer` переписывается на `resolveNpxLaunch` (сохранённые
  `logger.debug`), и **добавляет блок**: если `useNpxFallback && isOfflineLsp()`
  → `throw new Error("LSP offline mode: <binary|npx> not found in PATH; npx
  auto-install is disabled (MMA_LSP_OFFLINE)")` до `spawn` (сеть не трогаем).
- `MMA_LSP_OFFLINE` добавляется в `src/config/env.ts` (`MMA_ENV.LSP_OFFLINE`).

## 5. `/lsp doctor`

`src/cli/repl-commands-lsp.ts` — новый хендлер `doctor` в существующей
handler-map (правило #17). Вывод по STYLE.md: строки/глифы, без боксов,
`·`-разделители, `↳` для деталей.

Пример:

```
LSP doctor
  enabled · yes
  offline · no
  project · E:\proj
  ✓ typescript · ok (1.2s) · via global binary
  ✗ python · network · npx download failed — registry unreachable?
      ↳ set a mirror via lsp.servers.python.env.npm_config_registry, install pyright on PATH, or MMA_LSP_OFFLINE=1
  ✗ rust · binary not found · rust-analyzer
      ↳ install rust-analyzer or point lsp.servers.rust.command at it
  – css · no matching files
```

- Глифы: `✓` (зелёный) ok, `✗` (красный) реальный сбой, `–` (dim) disabled/
  not-applicable/deadline.
- Строка сервера: `<glyph> <lang> · <reason-label> · <detail>`; опциональный
  `↳`-hint только для классов, у которых есть действие.
- В конце — общая подсказка про закрытую сеть (если есть хотя бы один
  network/offline/binary-missing).
- `probe` реально спавнит npx-серверы (может скачивать). Это осознанно: doctor
  запускается явно и возвращает честный статус. Дедлайн ограничивает ожидание.
- `/lsp doctor` доступен как подкоманда; completer `SubcommandProvider("lsp", …)`
  в `repl.ts` расширяется `doctor`.
- `/lsp doctor` использует `LspModule.diagnose()` (прокидывает logger/clients).

## 6. Actionable-подсказки в `[LSP check failed]`

`LspModule` (плагин `onAfterTool` и `lsp_check`) при падении проверки дописывает
к текущему `[LSP check failed]: <msg>` одну классифицированную строку:

```
[LSP check failed]: LSP request timeout: initialize
hint: cannot reach the npm registry to download the LSP server — install it on PATH, set a registry mirror, or set MMA_LSP_OFFLINE=1
```

Классы и ключи i18n:
- `lsp.hint_binary_missing` → поставить сервер / `lsp.servers.<lang>.command`
- `lsp.hint_network` → реестр/зеркало/`MMA_LSP_OFFLINE`
- `lsp.hint_offline` → `MMA_LSP_OFFLINE` и бинарник не найден
- `lsp.hint_spawn` → проверить команду/PATH
- `lsp.hint_timeout` → сервер медленный / увеличить `lsp.servers.<lang>.timeout`

Порог отключения (3 подряд) и формат `[LSP disabled: …]` не меняются — после
отключения сервер молчит (тест `lsp-module.test.ts` на «четвёртый вызов без
шума» сохраняется).

## 7. i18n (en + ru, паритет обязателен)

`repl.*` (doctor):

| Ключ | en | ru |
| --- | --- | --- |
| `repl.lsp` | LSP server management (status, restart, check, doctor) | Управление LSP-серверами (status, restart, check, doctor) |
| `repl.lsp_usage` | Usage: /lsp [status\|restart\|check <path>\|doctor] | Использование: /lsp [status\|restart\|check <путь>\|doctor] |
| `repl.lsp_doctor_header` | LSP doctor | LSP-диагностика |
| `repl.lsp_doctor_enabled` | enabled | включён |
| `repl.lsp_doctor_offline` | offline | офлайн |
| `repl.lsp_doctor_project` | project | проект |
| `repl.lsp_doctor_yes` | yes | да |
| `repl.lsp_doctor_no` | no | нет |
| `repl.lsp_doctor_none` | no configured servers | серверы не настроены |
| `repl.lsp_reason_ok` | ok | ок |
| `repl.lsp_reason_disabled` | disabled | отключён |
| `repl.lsp_reason_not_applicable` | no matching files | нет подходящих файлов |
| `repl.lsp_reason_binary_missing` | binary not found | бинарник не найден |
| `repl.lsp_reason_offline` | offline — install the binary | офлайн — поставьте бинарник |
| `repl.lsp_reason_network` | network — server download failed | сеть — не удалось скачать сервер |
| `repl.lsp_reason_timeout` | timeout (initialize) | таймаут (initialize) |
| `repl.lsp_reason_spawn_failed` | spawn failed | не удалось запустить процесс |
| `repl.lsp_reason_server_error` | server error | ошибка сервера |
| `repl.lsp_reason_deadline` | skipped (deadline) | пропущен (дедлайн) |
| `repl.lsp_doctor_via` | via | через |
| `repl.lsp_via_global` | global binary | глобальный бинарник |
| `repl.lsp_via_npx` | npx (download) | npx (скачивание) |
| `repl.lsp_doctor_hint` | locked-down network? install servers on PATH, set a registry mirror in lsp.servers.<lang>.env, or set MMA_LSP_OFFLINE=1 | закрытая сеть? поставьте серверы в PATH, укажите зеркало реестра в lsp.servers.<lang>.env или MMA_LSP_OFFLINE=1 |

`lsp.*` (подсказки модели) + `lsp.sub_doctor` (completer):

| Ключ | en | ru |
| --- | --- | --- |
| `lsp.sub_doctor` | Diagnose LSP servers | Диагностика LSP-серверов |
| `lsp.hint_binary_missing` | install the language server or set lsp.servers.<lang>.command to an existing binary | поставьте language server или укажите lsp.servers.<lang>.command на существующий бинарник |
| `lsp.hint_network` | cannot download the language server (npm registry unavailable) — install it on PATH, set a registry mirror, or set MMA_LSP_OFFLINE=1 | не удаётся скачать language server (npm-реестр недоступен) — поставьте его в PATH, укажите зеркало реестра или MMA_LSP_OFFLINE=1 |
| `lsp.hint_offline` | offline mode is on and the server binary is not in PATH | включён офлайн-режим, а бинарника сервера нет в PATH |
| `lsp.hint_spawn` | the server command failed to start — check the command and PATH | не удалось запустить команду сервера — проверьте команду и PATH |
| `lsp.hint_timeout` | the server did not initialize in time — it may be slow; raise lsp.servers.<lang>.timeout | сервер не инициализировался вовремя — возможно, медленный; увеличьте lsp.servers.<lang>.timeout |

## 8. Изменения файлов

| Файл | Что |
| --- | --- |
| `src/config/env.ts` | `MMA_ENV.LSP_OFFLINE = "MMA_LSP_OFFLINE"` |
| `src/modules/lsp/resolve.ts` | **new** — `extractBinaryFromNpxArgs`, `isPackageVersion`, `findOnPath`, `resolveNpxLaunch`, `isOfflineLsp`, `NpxLaunch` |
| `src/modules/lsp/client.ts` | `startServer` через `resolveNpxLaunch`; offline-throw; приватные `extractBinaryFromNpxArgs`/`isPackageVersion` удалены |
| `src/modules/lsp/diagnose.ts` | **new** — `diagnoseLspServers`, `classifyLspError`, типы |
| `src/modules/lsp/module.ts` | `diagnose()`; classified hint в двух failure-точках |
| `src/modules/lsp/index.ts` | реэкспорт `diagnoseLspServers`/типов (по необходимости) |
| `src/cli/repl-commands-lsp.ts` | хендлер `doctor` |
| `src/cli/repl.ts` | `doctor` в `SubcommandProvider("lsp", …)` |
| `src/i18n/en.json`, `ru.json` | ключи §7 |
| `docs/agents/tools.md` | раздел «LSP in locked-down networks» |
| `CHANGELOG.md`, `AGENTS.md`, `package.json` | версия/доки |

## 9. Тесты

- `tests/modules/lsp/resolve.test.ts` — `extractBinaryFromNpxArgs` (строгий
  layout / angular-хвост → null), `isPackageVersion`, `resolveNpxLaunch`
  (npx→global, npx fallback, не-npx), `isOfflineLsp` (env `0/false/""` → false).
- `tests/modules/lsp/diagnose.test.ts` — с инжектированным `client`/`findOnPath`/
  `collectFiles`: disabled, not-applicable, binary-missing (`autoInstall:false`),
  offline (skip npx), ok, network (timeout + npxFallback), timeout (timeout без
  fallback), spawn-failed, deadline; `classifyLspError` по всем веткам.
- `tests/lsp-module.test.ts` — `diagnose()` доступен; failure дописывает
  `hint:`-строку нужного класса; «четвёртый вызов молчит» не сломан.
- `tests/lsp-client-framing.test.ts` / `tests/lsp-command.test.ts` — без
  регрессий (существующие).
- `tests/i18n.test.ts` — паритет en/ru новых ключей (автоматически).
- `tests/cli-*` (completer) — `doctor` присутствует, если такой тест есть;
  иначе source-guard.

## 10. Три измерения (Engineering Principles)

- **Реальный пользователь:** одна команда `/lsp doctor` отвечает «почему не
  работает» и «что сделать»; понятные классы вместо сырого таймаута; офлайн-флаг
  для запертой сети; вывод по STYLE.md.
- **ИИ-модель:** при сбое LSP в контекст идёт одна actionable строка-подсказка
  (модель перестаёт слепо ретраить и уходит на build/test); новых тулов нет,
  формат `lsp_check` не меняется.
- **Смежные модули:** `probe.ts`/баннер/`startup-check.ts` не тронуты;
  `client.startServer` — рефакторинг с сохранением поведения + один offline-
  guard; `LspModule` API расширен аддитивно; `/config` не меняется; env — через
  `MMA_ENV`.

## 11. Приёмка

1. `bun test` и `bun run quality` зелёные.
2. `/lsp doctor` на проекте без сети показывает `network`/`offline`/`binary-missing`
   с подсказкой; на рабочем проекте — `ok` с временем.
3. `MMA_LSP_OFFLINE=1` не запускает npx: сервер без глобального бинарника
   получает `offline`, сеть не трогается.
4. При сбое записи файла в tool-output появляется `[LSP check failed]` + `hint:`
   класса; после 3 сбоев — прежнее `[LSP disabled]`.
5. en/ru паритет; `AGENTS.md`/`CHANGELOG.md` обновлены; версия — MINOR.

## 12. WebUI LSP tab (часть 2)

Четвёртая вкладка web-сайдбара (`Session / Map / Trace / LSP`) с тем же
содержанием, что `/lsp doctor`, но по HTTP.

### 12.1 Backend

- **`BootstrapResult.lspModule?: LspModule`** + `ModulesPhase.lspModule`:
  `startLanguageModules` возвращает зарегистрированный `LspModule`; bootstrap
  пробрасывает его наружу. `web-command.ts` передаёт `lsp: lspModule` в
  `startWebUi`.
- **`WebUiDeps.lsp?: WebLsp`** (узкий: `diagnose(baseDir): Promise<LspDiagnosis>`).
  `module.ts` вяжет `state.lspDiagnose = () => deps.lsp.diagnose(deps.baseDir)`.
- **`WebUiState`**: `lspDiagnose?`, `lspDoctor?` (кэш), `lspProbing?`.
- **`lsp-api.ts`** (new):
  - `GET /api/lsp/doctor` → `{ diagnosis: lspDoctor ?? null, probing }`; без
    `lspDiagnose` → `503 unavailable`.
  - `POST /api/lsp/doctor` → single-flight re-probe: busy → `202 {probing:true}`;
    иначе `202`, SSE `lsp {phase:"start"}`, асинхронная проба →
    `lsp {phase:"done"|"error"}`, запись кэша, `state`-broadcast (`lspProbing` в
    конце). Проба может идти до 45с — HTTP не держим, клиент слушает SSE.
- Роуты — в точной таблице `API_ROUTES` (`GET`/`POST /api/lsp/doctor`); они не
  конфликтуют с существующим `GET /api/lsp` (таблица настроек, 2.10.0).

### 12.2 Frontend

- `index.html`: 4-я кнопка `.sb-tab[data-tab="lsp"]` (Lucide `stethoscope`) +
  `<div class="sb-pane" id="pane-lsp"><div class="sec"><div id="lspBody"></div></div></div>`.
- `dom.js`: иконка `stethoscope`.
- `sidebar.js`: `TABS` += `lsp`, `ICON_NAME.lsp="stethoscope"`, `lspEl`,
  `renderLsp()`; публичные `sidebarLspState()` (рендер из кэша) и
  `sidebarLspEvent()` (SSE `lsp` → refetch). Клик по вкладке при пустом кэше
  авто-запускает проверку; кнопка «Re-check» повторяет. Горячая клавиша `Alt+4`.
- `app.js`: SSE-подписка `lsp` → `sidebarLspEvent()`; `renderState` →
  `sidebarLspState()`; `applyStaticI18n` → `applySidebarI18n` уже покрывает.
- Раскладка вкладки — переиспользует `.sec`/`.kv`/кнопку `.map-reindex`; никаких
  боксов, по STYLE.md.

### 12.3 i18n (en+ru)

`web.sidebar.tab_lsp`, `web.sidebar.lsp_status/enabled/offline/check/checking/
not_checked/none/via/via_global/via_npx/hint` и 10 ярлыков `web.sidebar.lsp_reason_*`
(ok/disabled/not_applicable/binary_missing/offline/network/timeout/spawn_failed/
server_error/deadline).

### 12.4 Приёмка (часть 2)

- В сайдбаре 4 вкладки; `Alt+4` открывает LSP; вкладка рисует `enabled/offline`
  и строки серверов с глифами/классом/длительностью.
- «Re-check» заново пробует серверы; во время пробы — статус «проверяется» и
  disabled-кнопка; полученный результат кэшируется в state и переживает
 2с-поллинг.
- Без `lspModule` (тесты) — вкладка показывает «недоступно», `GET/POST` → `503`.
- en/ru паритет.

## 13. Версионный тулчейн проекта (2026-10-14)

**Проблема.** `installCommandFor` советовал установить «последнюю» версию сервера
(`typescript@5`, `@latest`) независимо от того, на каком рантайме реально
собирается проект. Кейс: Angular 11 на Node 16 — подсказка была рассчитана на
Node 20+, установка ломала сборку. Ориентир только на JS неверен: версии нужно
читать для всех языков.

**Что делаем.**

- Новый чистый модуль `src/modules/lsp/toolchain.ts`:
  `detectProjectToolchain(baseDir): ProjectToolchain` — читает стандартные
  манифесты **всех** языков, без запуска процессов:
  `.nvmrc`/`.node-version`/`package.json#engines`, `typescript` и `@angular/*`
  из `package.json`; `.python-version`/`runtime.txt`/`pyproject.toml`;
  `rust-toolchain[.toml]`; `go.mod`; `.ruby-version`; `.java-version`;
  `composer.json`; `global.json`. Формат:
  `{ runtimes: [{name, version, source}], packages: {name→version} }`.
- `installCommandFor(server, reason, npxFallback, toolchain?)`:
  - npm-пакеты `--package` подставляются версиями из `toolchain.packages`
    (`typescript@5` → `typescript@4.1.6`, если проект объявляет 4.1.6);
  - нативные установщики учитывают канал тулчейна
    (`rustup component add rust-analyzer --toolchain 1.65.0`).
  Поле `toolchain` опционально — без него поведение 1:1 прежнее.
- `LspDiagnosis.toolchain?: ProjectToolchain` — аддитивное поле `/api/lsp/doctor`;
  вкладка LSP показывает строку «тулчейн» (какие версии учтены).

**Non-goals.** Не подбираем «совместимую» версию сервера по таблице
совместимости (её нет): пиним к тому, что объявил проект, а иначе оставляем
прежний дефолт. Не запускаем инструменты для определения версий.

**Приёмка.** `tests/modules/lsp/toolchain.test.ts` (js/python/rust/go/ruby/php/
dotnet); `tests/modules/lsp/diagnose.test.ts` (пин npm-версии, rust channel);
en/ru ключ `web.sidebar.lsp_toolchain`.

