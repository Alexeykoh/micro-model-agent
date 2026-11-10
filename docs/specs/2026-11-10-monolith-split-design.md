# Спека: полное разделение монолита UI / runtime

**Дата:** 2026-11-10 · **Статус:** draft (норматив для новых волн) · **Ветка:** `feat/monolith-split`
**Предыдущая спека:** [`2026-11-09-daemon-wire-design.md`](./2026-11-09-daemon-wire-design.md) (волна -1)
**Источник идеи:** [`docs/ideas/2026-11-09-mma-enterprise-separate-version.md`](../ideas/2026-11-09-mma-enterprise-separate-version.md) §3.4, §4, §7, §13

> **Что это.** Целевой контракт разделения: один runtime-процесс (`mma serve`)
> и N UI-процессов (`mma`, `mma web`, `mma "prompt" --daemon`), связанных
> версионированным HTTP+SSE контрактом. Локальный режим остаётся in-process
> реализацией того же интерфейса `Host`.
>
> **Чего здесь нет.** Порядок реализации — в плане. Здесь — что правильно,
> какие инварианты должны быть истинны и какой контракт получает клиент.

---

## 1. Проблема

Три поверхности (`mma`, `mma web`, `mma serve`) собирают свой рантайм в своём
процессе. Фактически путей исполнения два: `mma web` и `mma` — независимые
Runtime-процессы с собственными `Agent`, `ToolExecutor`, `SessionManager`,
конфигом и workspace.

Конкретные места связности:

- `Host`/`HostBridge` привязаны к процесс-глобальному `defaultOutputBus`
  (`src/core/host.ts:156`, `src/cli/repl-host.ts:84`) — подписка на события
  не может пересечь границу процесса.
- `WebHost.submit` — заглушка (`src/core/web-host.ts:25-29`); веб-ход идёт
  мимо `Host`, через `RunPool` + `SessionRunner` + SSE
  (`src/modules/webui/module.ts:205-238`). Это второй путь запуска хода.
- `service` импортирует `RunPool` (`src/modules/service/state.ts:15`),
  egress (`server.ts:19`), body-хелперы (`http/respond.ts:7-8`), scrub
  (`runtime/event-bridge.ts:11`), `isLoopback` (`runtime/callback-url.ts:12`)
  из `webui` — модуль «веб» де-факто является слоем рантайма.
- `Repl` реализует `Host` сам и держит терминальное состояние вперемешку с
  агентным (`src/cli/repl.ts:61-115`).

Следствие: недоступны control plane с подписанной политикой, thin-режим,
отзыв доступа, централизованный аудит и разные клиенты одного демона.
Любой «enterprise-флаг» в монолите локально пропатчится.

## 2. Цель

**Один runtime-процесс и N UI-процессов.** UI-процесс не конструирует
`Agent`, `ToolExecutor`, `SessionManager`, `ConfigStore` и не владеет
workspace. Всё состояние хода, сессий и конфига живёт в runtime-процессе;
клиент — тонкий рендерер событий и отправитель команд.

Локальный режим (`mma` без демона) сохраняется как поведенческий эквивалент:
тот же интерфейс `Host`, но реализация `LocalHost` работает in-process.

## 3. Границы (non-goals)

В эту спеку **не** входит:

- **TUI.** Реализации нет; контракт проектируется так, чтобы TUI мог стать
  клиентом, но сам TUI — не эта спека.
- **Per-user identity, OIDC, tier/scopes.** Это enterprise-волна; уже есть
  долг `service-tier-scopes-control-plane` (`docs/agents/debt.md:43`).
- **Мульти-workspace на одном демоне.** Демон — silo с одним workspace.
- **Возобновление хода после падения демона.** Активный ход теряется;
  `checkpoint.json` восстанавливает счётчики для следующего хода.
- **Изменение job API `/v1/tasks`.** Оно остаётся обратно совместимым.
- **Перенос браузерного API на демон.** Браузер продолжает говорить с
  `mma web`; адаптер проксирует.
- **Удалённый sandbox.** `execution.profile: sandbox` исполняется на хосте
  демона; семантика на удалённом хосте не переопределяется.

## 4. Текущее состояние (AS-IS)

| Поверхность | Вход | Runtime | Состояние |
|---|---|---|---|
| `mma` (REPL) | `src/cli/main.ts` → `Repl` | в-processс `Agent` + `HostBridge` | терминал + агент в одном процессе |
| `mma web` | `src/cli/web-command.ts` → `startWebUi` | в-processс `WebHost` + `RunPool` + `SessionRunner` | браузер тонкий, сервер — рантайм |
| `mma serve` | `src/cli/service-command.ts` → `startAgentService` | в-processс `RunPool` + `SessionRunner` | job API `/v1`, сессии на диске |
| `mma "prompt"` | `src/cli/main-oneshot.ts` | в-processс `Agent` | локальный запуск |

Уже готово для wire: `SessionRunner` (`src/core/bootstrap/session-runner.ts`),
`HostStateSnapshot`/`buildHostState` (`src/core/host-state.ts`), `OutputEvent`
(`src/output/types.ts`), `PromptIO` (`src/tools/prompt-io.ts`), командный
каталог с `surfaces` (`src/core/commands/catalog.ts`), Agent Service API `/v1`
(`src/modules/service/`), чекпоинт/пауза на диске
(`src/modules/session/checkpoint*.ts`, `interrupt.ts`), протокол и токен
(`src/modules/daemon/protocol.ts`).

## 5. Целевая топология (TARGET)

```
┌────────────────────────── UI процессы ──────────────────────────┐
│  mma (REPL)          mma web (адаптер)       mma "prompt"        │
│  LineEditor          browser /api/* (as-is)  --daemon           │
│  Renderer            WebHost → RemoteHost    через job API /v1   │
│  history/complete    proxy → RemoteHost                          │
└──────────┬───────────────────┬──────────────────────┬────────────┘
           │ Host (interface)   │ HTTP+SSE /v1/host    │
           │ LocalHost          │ RemoteHost           │
           ▼                   ▼                      │
┌──────────────────────── runtime процесс ────────────────────────┐
│  mma serve (daemon)                                                │
│  SessionRunner · RunPool · ToolExecutor · ConfigStore · SessionStore │
│  Agent Service API /v1 (job + host) · SSE envelope                │
│  bearer token · tenant silo · optional TLS · workspace (silo)     │
└───────────────────────────────────────────────────────────────────┘
```

**Что остаётся на клиенте:** `LineEditor` (raw mode, DSR, history,
completion), `Renderer`/`Spinner`/`ThoughtBlock`/`BodyStream`, `plan-view`,
`action-log`, история ввода, комплитер, локаль, размер терминала,
keybindings.

**Что уезжает в демон:** петля агента, тулы и enforcement, сессии и их
история, конфиг, workspace, модули (indexer, LSP, MCP, memory, skills,
plugins), шина событий, резолверы HITL-вопросов, обработка изображений.

## 6. Контракт `Host`

`Host` (`src/core/host.ts`) — единственный интерфейс, который видит UI.
Существующий `Host` расширяется до полной поверхности:

```ts
interface Host {
  // ход
  submit(text: string, opts?: { images?: string[] }): Promise<TurnHandle>;
  interrupt(sessionId?: string): void;
  pause(sessionId?: string): Promise<void>;
  resume(sessionId?: string): Promise<void>;
  answer(sessionId: string, questionId: string, answer: unknown): Promise<void>;
  executeCommand(line: string): Promise<void>;

  // состояние
  getState(sessionId?: string): Promise<HostStateSnapshot>;
  subscribeEvents(fn: (ev: HostEvent) => void): () => void;

  // сессии
  listSessions(): Promise<SessionSummary[]>;
  createSession(name?: string): Promise<SessionSummary>;
  activateSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  getHistory(sessionId: string): Promise<SessionMessage[]>;
  getLog(sessionId: string): Promise<string>;

  // конфиг и модели
  getConfig(): Promise<ConfigSnapshot>;
  setConfig(key: string, value: unknown): Promise<ConfigEffect[]>;
  listModels(): Promise<ModelInfo[]>;
}
```

Две реализации:

- **`LocalHost`** — in-process. Обёртка над существующими `Agent`,
  `SessionManager`, `OutputBus`. Поведение совпадает с сегодняшним.
- **`RemoteHost`** — HTTP+SSE к демону. Тот же интерфейс, никакой
  самостоятельной логики хода.

`Repl` и `WebHost` становятся **потребителями** `Host`, а не его
реализациями. `HostBridge` (плагинный контракт) сохраняется, но его
`subscribeOutput` переводится на `subscribeEvents` выбранного транспорта.

**Событие хоста** — JSON-совместимое:

```ts
type HostEvent = {
  type: HostEventType;
  ts: number;
  sessionId?: string;
  source?: Source;          // INV-13: mma | module:<name> | tool:<name> | core
  data?: unknown;
};
```

Словарь событий — существующий веб-словарь: `text`, `meta`, `reasoning`,
`phase`, `tool_start`, `tool_end`, `plan`, `turn_end`, `retract`, `critic`,
`question`, `state`, `usage`, `log`, `llm_request`, `security`, `subagent`,
`command`, `sessions`, `config`, `models`, `files`, `index`, `update`,
`error`. Никакой процесс-глобального состояния в контракте нет.

На проводе `HostEvent` едет внутри `Envelope` (§7.2): `type` = имя события,
`data` = payload. `TurnHandle` — минимальный дескриптор хода
(`{ turnId, sessionId }`); `ConfigEffect` — существующий тип из
`src/config/effects.ts`.

## 7. Wire-контракт `/v1/host`

Интерактивная поверхность живёт в том же сервере, что и job API, но в
отдельном семействе путей `/v1/host/*` (тег `host` в OpenAPI). Job API
`/v1/tasks/*` не меняется.

### 7.1. Эндпоинты

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/v1/host/state?session=` | `HostStateSnapshot` + `workspace`, `version`, `protocol` |
| POST | `/v1/host/sessions` | создать/активировать сессию |
| GET | `/v1/host/sessions` | список сессий |
| DELETE | `/v1/host/sessions/:id` | удалить (409 при занятости) |
| POST | `/v1/host/sessions/:id/submit` | `{text, images?}` → `202` + `turnId` |
| GET | `/v1/host/sessions/:id/stream` | SSE: envelope + resume |
| POST | `/v1/host/sessions/:id/command` | `{line}` → `202`, вывод в SSE |
| POST | `/v1/host/sessions/:id/interrupt` | `202` |
| POST | `/v1/host/sessions/:id/pause` | `202` |
| POST | `/v1/host/sessions/:id/resume` | `202` |
| POST | `/v1/host/sessions/:id/answer` | `{id, answer}` → `202`/`409` |
| GET | `/v1/host/sessions/:id/history` | история сессии |
| GET | `/v1/host/sessions/:id/log` | хвост `session.jsonl` |
| GET | `/v1/host/sessions/:id/system-prompt` | системный промпт |
| GET | `/v1/host/sessions/:id/security` | security-журнал |
| GET | `/v1/host/sessions/:id/subagents` | субагенты |
| GET | `/v1/host/config` | конфиг |
| POST | `/v1/host/config` | запись ключа, возвращает эффекты |
| GET | `/v1/host/models` | список моделей |
| GET | `/v1/host/files`, `/git`, `/search`, `/lsp`, `/memory`, `/skills`, `/plugins`, `/setup`, `/index`, `/update` | веб-поверхность, проксируется адаптером (состав — по существующему веб-API) |

### 7.2. Транспорт и авторизация

- HTTP/1.1, `node:http` (работает и в Bun, и в Node-дисте). WebSocket нет.
- SSE — существующий `Envelope { v:1, seq, ts, type, sessionId, data }`
  (`src/modules/service/runtime/envelope.ts`); resume по `Last-Event-ID`
  и `?since=`; keep-alive; лимит клиентов; backpressure-destroy
  (переиспользуем `api/events-api.ts`).
- Авторизация — bearer-токен процесса (silo), `X-Mma-Tenant`,
  `X-Mma-Principal` (аудитная метка), `X-Mma-Locale` (локаль клиента).
- Ошибки — RFC 9457 `problem+json` (существующий `runtime/problem.ts`).

### 7.3. Версионирование

`PROTOCOL_VERSION` остаётся единым для сервера. Клиент при коннекте сверяет
major и отвергает несовместимый (fail-fast, существующий
`protocolCompatible`). Новые роуты обязаны иметь строку в
`openapi/operations.ts` (гвард `tests/service/openapi.test.ts`).

## 8. Модель сессии и HITL

- **Очередь:** per-session single-flight + FIFO — существующий `RunPool`.
  Любой клиент может писать в любую видимую сессию; ход ставится в очередь.
- **Вопросы:** `question`/`approve` — событие `question` рассылается всем
  подписчикам сессии; первый `answer` побеждает; TTL 30 мин; по таймауту
  тул получает ошибку и ход продолжается. Вопрос **не привязан к
  соединению**: переподключившийся клиент получает его из сессии.
- **Прерывание и пауза:** `interrupt` — кооперативная остановка на границе
  итерации; `pause`/`resume` — персистятся в `interrupt.json` и переживают
  рестарт демона.
- **Падение демона:** активный ход теряется. Клиент переподключается,
  получает `state` и историю; `checkpoint.json` восстанавливает счётчики
  для следующего хода. Возобновление с того же места не гарантируется и
  в эту спеку не входит.
- **Изображения:** клиент отправляет `images` в `submit`; демон хранит их
  в `images/` сессии и прикрепляет к ходу (существующий путь веба).

## 9. Локальный режим

- Конфиг `host.mode: local | daemon` (дефолт `local`) либо флаг `--daemon`.
- `LocalHost` — существующее поведение: агент in-process, без сети.
- Демон стартует явно (`mma serve`). Автозапуск демона из `mma --daemon`
  не делаем: фоновый процесс должен быть явным (правило 8 AGENTS.md).
  Если демон недоступен — внятная ошибка с подсказкой `mma serve`.
- Локальный и удалённый режимы — один и тот же код UI; разница только в
  транспорте под `Host`.

## 10. Web-адаптер

`mma web` сохраняет браузерный API (`/api/*`), ассеты, cookie-auth, rate
limit и рендеринг — браузер не меняется. Но вместо собственного рантайма
адаптер использует `Host`:

- `host.mode: local` — `LocalHost` (как сегодня);
- `host.mode: daemon` — `RemoteHost`, проксирование в `/v1/host/*`.

Следствие: `WebHost.submit` перестаёт быть заглушкой; веб-ход идёт через
`Host`, как и в REPL. Это устраняет второй путь запуска хода.

## 11. One-shot

`mma "prompt"` по умолчанию остаётся локальным (CI, скрипты, офлайн).
`--daemon` маршрутизирует запуск через job API `/v1/tasks` — отдельный
Host-контракт для этого не нужен.

## 12. TLS, авторизация, workspace

- **TLS:** optional in-app. `service.tls.cert` / `service.tls.key`; если не
  заданы — HTTP. Клиент говорит `https://` по конфигурации
  (`MMA_DAEMON_URL` или `--daemon <url>`).
- **Bind:** loopback — как сейчас (токен опционален для локальной
  разработки). Нелупбэк — обязателен токен **и** TLS; иначе отказ при
  старте.
- **Авторизация:** токен процесса (silo). `X-Mma-Principal` — аудитная
  метка. Per-user — позже (enterprise).
- **Workspace:** один на демон, фиксируется при старте (`--project` или
  cwd). Клиент не выбирает и не создаёт; он читает `state.workspace` и
  показывает его. Локально cwd клиента и workspace демона совпадают, для
  удалённого это принципиально: cwd клиента не имеет значения.
- **Токен:** `~/.mma/daemon.token` (0600) или `MMA_DAEMON_TOKEN`. Смена
  токена требует рестарта демона (as-is, документируется).

## 13. Локаль

- Локаль — свойство клиента: заголовок `X-Mma-Locale` на каждый запрос.
- Демон хранит локаль в `AsyncLocalStorage` и использует её для
  пользовательского вывода в этом запросе/сессии.
- Модельные промпты не локализуются (язык модели не зависит от UI).
- Процесс-глобальный `i18n` устраняется; это отдельная волна рефакторинга
  с риском регрессий в CLI-строках.

## 14. Обратная совместимость

- Job API `/v1/tasks/*` не меняется; 27 тестов `tests/service/*` остаются
  зелёными.
- Существующие сессии на диске читаются как раньше; миграция не нужна.
- `mma` без демона ведёт себя как сегодня.
- Новые роуты добавляются в `operations.ts`; новые типы событий — в
  `EVENT_TYPES` (гвард `tests/service/contract.test.ts`).
- Волна -1 (`daemon/protocol.ts`) остаётся: `PROTOCOL_VERSION`, токен,
  `DaemonClient` расширяется до полноценного `RemoteHost`.

## 15. Путь к цели (волны)

Порядок и шаги — в плане. Здесь — только назначение волн; каждая волна
отдельной веткой с зелёными `bun test` + `bun run quality`.

| Волна | Назначение |
|---|---|
| W0 | Вынести общий рантайм-слой (`RunPool`, egress, body, scrub, `PlanSnapshot`) из `webui` в нейтральный слой; `service` перестаёт зависеть от `webui`. Поведение не меняется. |
| W1 | Контракт `Host`: `LocalHost`/`RemoteHost`, транспорт-нейтральная подписка, расширение интерфейса. REPL переходит на `Host` (local by default). |
| W2 | Интерактивный wire `/v1/host/*`: state, sessions, submit, stream, command, interrupt, pause/resume, answer, history/log, config. Contract-тесты. |
| W3 | REPL thin-клиент: полный `RemoteHost`, терминальный рендер на клиенте, slash-команды по wire, изображения, локаль. |
| W4 | Web-адаптер: проксирование `/api/*` в `/v1/host/*` в режиме daemon. |
| W5 | One-shot `--daemon` через job API. |
| W6 | TLS и удалённая закалка: in-app TLS, требования к нелупбэк-биндцу, ротация токена, фикс `deploy/Dockerfile.service`. |
| W7 | Документация, реестр долгов, удаление устаревших заглушек. |

## 16. Тестирование и гейты

- **Contract:** каждый `/v1/host` роут — строка в `operations.ts`; каждый
  тип события — в `EVENT_TYPES`; envelope/SSE resume/auth/locale — тесты.
- **Интеграция:** реальный демон (spawn `startAgentService` in-process или
  подпроцессом) — connect, submit, stream, interrupt, question/answer,
  reconnect, два клиента на одной сессии, рестарт демона.
- **Паритет:** `LocalHost` и `RemoteHost` проходят один набор тестов
  (`Host` behavior suite).
- **Web-адаптер:** паритет браузерного API в local и daemon режимах.
- **Гейты репозитория:** file-size ≤300, module-boundaries, outbound-policy
  (новый `fetch` в `RemoteHost` — в allowlist), observability-coverage,
  coverage (funcs ≥87, lines ≥90), debt-register.

## 17. Инварианты разделения

- **INV-S1. Один runtime.** UI-процесс не конструирует `Agent`,
  `ToolExecutor`, `SessionManager`, `ConfigStore` и не владеет workspace.
- **INV-S2. Один интерфейс.** Все UI-поверхности зависят от `Host`;
  транспорт выбирается конфигом. Нет второго пути исполнения хода.
- **INV-S3. Сериализуемость.** Всё, что уходит по wire, — JSON-совместимое
  событие с `source`; процесс-глобальное состояние в контракте запрещено.
- **INV-S4. Сессия принадлежит демону.** Клиент не хранит историю, конфиг
  и сессии локально (кроме терминального UI).
- **INV-S5. Вопрос не привязан к соединению.** HITL-вопрос живёт в сессии,
  TTL 30 мин, доставляется любому подписчику; первый ответ побеждает.
- **INV-S6. Ход не возобновляется.** Падение демона теряет ход;
  `checkpoint.json` восстанавливает счётчики для следующего хода.
- **INV-S7. Локальный режим — тот же контракт.** `LocalHost` и
  `RemoteHost` реализуют один `Host`; локальное поведение не меняется.
- **INV-S8. Версионирование.** Клиент отвергает несовместимый major;
  job API `/v1/tasks` не меняется.
- **INV-S9. Enforcement в точке исполнения.** Allowlist, scope, SSRF и
  rate-limit применяются в `ToolExecutor` в демоне; клиент не может их
  обойти.
- **INV-S10. Локаль — свойство клиента.** `X-Mma-Locale` на каждый запрос;
  модельные промпты не локализуются.

## 18. Риски

1. **Локаль per-request.** `i18n` процесс-глобальный; перевод на ALS может
   задеть все CLI-строки. Митигация: волна отдельно, сначала аудит
   использований `t()`.
2. **Извлечение рантайм-слоя.** `RunPool`/egress/body/scrub живут в `webui`;
   перенос задевает `tests/webui-*` и `tests/service/*`. Митигация: W0 без
   изменения поведения, только перемещение файлов.
3. **Объём веб-поверхности.** Адаптеру нужен весь веб-API. Митигация:
   проксирование, а не переписывание; браузер не меняется.
4. **Жизненный цикл демона.** Кто стартует/останавливает, где логи, как
   ротация токена. Митигация: явный `mma serve`, документация в runbook;
   попытка автозапуска отложена.
5. **Паритет рендеринга.** Терминальный рендерер должен выглядеть так же,
   как сегодня, но получать события по сети. Митигация: переиспользовать
   словарь веб-событий и существующий `Renderer`.
6. **Сломанный `deploy/Dockerfile.service`.** `CMD` указывает на
   `src/index.ts` вместо CLI-входа. Митигация: исправить в W6.

## 19. Критерии готовности

- `mma` работает без демона (local) и с демоном (`--daemon`) с одинаковым
  поведением; паритет покрыт тестами.
- `mma web` в режиме daemon проксирует в `/v1/host/*`; браузерный API не
  изменился.
- `mma "prompt" --daemon` исполняется через job API.
- Демон переживает закрытие клиента; сессия и история на диске; вопрос
  доставляется переподключившемуся клиенту.
- Два клиента на одной сессии: FIFO, вопросы всем, первый ответ побеждает.
- Удалённый доступ: TLS + токен; нелупбэк-бинд без них отказывает.
- Локаль клиента не влияет на другие клиенты; модельные промпты не
  локализованы.
- Гейты: `bun test`, `bun run quality`, coverage, file-size, module
  boundaries, outbound-policy — зелёные.
- Документация: `docs/agents/service-api.md`, `docs/agents/architecture.md`,
  `deploy/RUNBOOK.md` описывают разделение; TODO и реестр долгов обновлены.
