# Web UI Plugin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Двусторонний веб-интерфейс для MMA-агента: чат из браузера (отправка сообщений + картинки), live-стриминг хода выполнения, план, история, interrupt.

**Architecture:** Folder-plugin `examples/plugins/web-ui/` по образцу проверенного trace-server (SSE over node:http, статические ассеты verbatim, scrub секретов). Двунаправленность обеспечивают две доработки агента: **HostBridge** (узкий интерфейс `{isBusy, submit, interrupt}`, который REPL регистрирует в PluginManager и менеджер подмешивает в ctx каждого хука) и новый хук **`onTurnEnd`** (единственный надёжный сигнал «ход завершён»).

**Tech Stack:** TypeScript (Bun + Node dist), vitest, node:http (ноль новых зависимостей), vanilla JS/CSS frontend.

---

## Решения после grill-me (self-interview)

| Вопрос | Решение |
|---|---|
| Чем отличается от trace-server? | Двусторонний чат; trace-server read-only. Переиспользуем его архитектурные паттерны. |
| Кто владеет вводом? | REPL. Веб-сообщения идут через тот же `Repl.runAgent()`; занят → `409`. Очередь — YAGNI. |
| Как плагин запускает агента? | `HostBridge` в PluginManager: `setHostBridge()` от хоста, `ctx.hostBridge` в каждом хуке. |
| Сигнал «ход завершён»? | Новый хук `onTurnEnd(ctx, summary)` в конце `Agent.run()` (обе ветки: single + MoE). |
| Транспорт? | SSE (downstream) + POST JSON (upstream). WebSocket отклонён (зависимость/Bun-specific). |
| История при открытии страницы? | `GET /api/state`: мета сессии, busy, активный план, хвост `history.jsonl` (~30 сообщений). |
| Безопасность? | Bind 127.0.0.1; `MMA_WEBUI_TOKEN` обязателен при non-localhost; cap клиентов 5; сообщение ≤32KB; ≤3 картинок по ≤6MB base64; rate-limit 500ms; scrub секретов. |
| Картинки? | Drag-n-drop/file input → клиентский даунскейл (canvas → max 800px, JPEG q60) → data URL → `submit(text,{images})` → `contextManager.addPendingImage()` (тот же путь, что Ctrl+V). |
| i18n (правило №8)? | Терминальные строки плагина — технические через logger (прецедент trace-server). Строки веб-UI — в статических ассетах (en); локализация фронтенда — фаза 2. Осознанное исключение, задокументировано. |
| Не входит в MVP | Смена/создание сессий, slash-команды, question/approve кнопки, настройки, полный markdown. |
| Версия | MINOR → 0.51.0 (новый plugin hook + HostBridge контракт + новый плагин). |

## File Structure

```
src/
├── modules/
│   ├── types.ts                    # MODIFY: HostBridge, HostBridgeSubmitOptions, TurnSummary, AgentPlugin.onTurnEnd
│   └── plugins/
│       └── manager.ts              # MODIFY: setHostBridge(), withHost(), runOnTurnEnd()
├── core/
│   └── agent.ts                    # MODIFY: dispatch onTurnEnd в конце run() (try/catch)
└── cli/
    └── repl.ts                     # MODIFY: createHostBridge() factory + wiring в start()
tests/
├── modules/plugin-host-bridge.test.ts   # CREATE
├── core/agent-turn-end.test.ts          # CREATE
└── web-ui-server.test.ts                # CREATE
examples/plugins/web-ui/                  # CREATE (папка-плагин)
├── plugin.ts     # entry: хуки → broadcast, жизненный цикл сервера
├── state.ts      # shared state + SSE clients + broadcast()
├── util.ts       # clip, scrub, safeJson (порт из trace-server)
├── history.ts    # чтение хвоста history.jsonl
├── plans-snap.ts # снапшот .mma/plans/active.json (+drafts/archive counts)
├── server.ts     # HTTP роутинг: static, /events, /api/state, /api/message, /api/interrupt
├── page.html     # разметка чата
├── styles.css    # тёмная тема (стиль trace-server)
└── app.js        # SSE client, рендер, input/busy, drag-n-drop images, Stop
_testing/web-ui-smoke.ts                   # CREATE: e2e smoke (мок-bridge, реальный сервер)
docs/plugins.md                            # MODIFY: HostBridge + onTurnEnd разделы
AGENTS.md                                  # MODIFY: Plugins section + version log
```

## Контракт HTTP/SSE

```
GET  /              → page.html (verbatim)
GET  /styles.css    → css
GET  /app.js        → js
GET  /events        → SSE; события:
    session {session}                       — мета сессии при коннекте/смене
    state  {busy}                           — текущее занятие агента
    phase  {iteration, phase}               — thinking/done
    llm_start {iteration, task}
    llm_end   {iteration, kind, callCount, durationMs}
    tool_start {toolCallId, name, args, summary}
    tool_end   {toolCallId, name, success, durationMs, output}
    text {chunk} / meta {chunk}             — стриминг
    error {message, stack?}
    turn_end {success, durationMs, textLength, toolCalls, iterations}
    plans  {active, drafts, archived}
POST /api/message   {text, images?: string[]} →
    202 {ok:true} | 400 invalid | 409 {error:"busy"} | 413 too_large |
    429 rate_limited | 503 {error:"no_bridge"} | 401 unauthorized
POST /api/interrupt → 200 {ok:true} | 409 {error:"idle"}
GET  /api/state     → {session, busy, plan, history:[{role,text,ts}], url}
```

Auth: если задан `MMA_WEBUI_TOKEN` — обязателен заголовок `x-mma-token` или `?token=` для `/api/*`; без токена не-localhost бинд отклоняется на старте.

---

### Task 1: HostBridge тип + хранение в PluginManager

**Files:**
- Modify: `src/modules/types.ts`
- Modify: `src/modules/plugins/manager.ts`
- Test: `tests/modules/plugin-host-bridge.test.ts`

- [ ] **Step 1: failing test**

```typescript
import { describe, it, expect } from "vitest";
import { PluginManager } from "../../src/modules/plugins/manager";
import type { HostBridge } from "../../src/modules/types";

const bridge: HostBridge = {
  isBusy: () => false,
  submit: async () => ({ success: true }),
  interrupt: () => {},
};

describe("PluginManager host bridge", () => {
  it("merges hostBridge into hook context", () => {
    const mgr = new PluginManager();
    let seen: unknown;
    mgr.register({ name: "spy", onSessionStart(ctx) { seen = ctx.hostBridge; } });
    mgr.setHostBridge(bridge);
    mgr.runOnSessionStart({ logger: console });
    expect(seen).toBe(bridge);
  });

  it("leaves ctx untouched when no bridge is set", () => {
    const mgr = new PluginManager();
    let keys: string[] = [];
    mgr.register({ name: "spy", onSessionStart(ctx) { keys = Object.keys(ctx); } });
    mgr.runOnSessionStart({ logger: console });
    expect(keys).not.toContain("hostBridge");
  });

  it("does not overwrite caller-provided hostBridge", () => {
    const mine: HostBridge = { ...bridge, isBusy: () => true };
    const mgr = new PluginManager();
    let seen: unknown;
    mgr.register({ name: "spy", onSessionStart(ctx) { seen = ctx.hostBridge; } });
    mgr.setHostBridge(bridge);
    mgr.runOnSessionStart({ hostBridge: mine });
    expect(seen).toBe(mine);
  });
});
```

- [ ] **Step 2:** Run: `bunx vitest run tests/modules/plugin-host-bridge.test.ts` → FAIL (`setHostBridge` не существует)
- [ ] **Step 3: implement** — `src/modules/types.ts`:

```typescript
export interface HostBridgeSubmitOptions {
  /** Image data URLs attached to the message (data:image/png;base64,...). */
  images?: string[];
}

/** Narrow API the host (REPL) exposes to plugins for driving the agent. */
export interface HostBridge {
  isBusy(): boolean;
  submit(text: string, opts?: HostBridgeSubmitOptions): Promise<unknown>;
  interrupt(): void;
}
```

`manager.ts`: поле `private hostBridge: HostBridge | null = null`, метод `setHostBridge()`, приватный `withHost(ctx)` (spread + hostBridge, если отсутствует), обёртка `this.withHost(ctx)` в начале всех 13 run*-диспетчеров.
- [ ] **Step 4:** тот же прогон → PASS
- [ ] **Step 5:** `git add -A && git commit -m "feat(plugins): HostBridge type + host bridge merge into plugin hook contexts"`

### Task 2: TurnSummary + onTurnEnd hook (types + manager)

**Files:** те же + тест расширяется.

- [ ] **Step 1: failing test**

```typescript
it("dispatches onTurnEnd with summary and isolation", () => {
  const mgr = new PluginManager();
  const seen: any[] = [];
  let boom = false;
  mgr.register({
    name: "collector",
    onTurnEnd(ctx, s) { seen.push([ctx.hostBridge?.isBusy?.() ?? "n/a", s]); },
  });
  mgr.register({ name: "bomb", onTurnEnd() { boom = true; throw new Error("x"); } });
  mgr.setHostBridge(bridge);
  mgr.runOnTurnEnd({}, { success: true, durationMs: 10, textLength: 1, toolCalls: 0 });
  expect(seen.length).toBe(1);
  expect(seen[0][1].success).toBe(true);
  expect(boom).toBe(true);
});
```

- [ ] **Step 2:** FAIL → **Step 3:** типы:

```typescript
export interface TurnSummary {
  success: boolean;
  durationMs: number;
  textLength: number;
  toolCalls: number;
  interrupted?: boolean;
}
// в AgentPlugin:
/** Called once when an agent run() completes (final answer, error or interrupt). */
onTurnEnd?(ctx: any, summary: TurnSummary): void;
```

и диспетчер `runOnTurnEnd(ctx, summary)` в менеджере (паттерн runOnPhase).
- [ ] **Step 4:** PASS → **Step 5:** commit `feat(plugins): onTurnEnd lifecycle hook + TurnSummary`

### Task 3: Диспетчеризация onTurnEnd в agent.ts

**Files:**
- Modify: `src/core/agent.ts` (run(), ~line 299)
- Test: `tests/core/agent-turn-end.test.ts`

- [ ] **Step 1: failing test** (гарнест по образцу tests/core/agent.test.ts: mock LLMProvider, отвечающий текстом без tool-calls)

```typescript
it("fires onTurnEnd once per run with summary (success)", async () => {
  // bootstrap минимального Agent с mock provider → result.text = "ok"
  const summaries: TurnSummary[] = [];
  deps.pluginManager.register({ name: "t", onTurnEnd(_c, s) { summaries.push(s); } });
  await agent.run("hello");
  expect(summaries.length).toBe(1);
  expect(summaries[0]).toMatchObject({ success: true, textLength: 2 });
});

it("fires onTurnEnd with success:false when LLM throws", async () => {
  // provider.chat throws
  await expect(agent.run("boom")).rejects.toThrow();
  expect(summaries[0].success).toBe(false);
});
```

- [ ] **Step 2:** FAIL → **Step 3: implement** — переработать `Agent.run()`: замер времени, счётчик tool-событий через wrapper над `onTool`, try/catch вокруг обеих веток, диспетчеризация в конце:

```typescript
async run(input, onChunk, onMeta, onTool, onPhase): Promise<AgentResult> {
  const startedAt = Date.now();
  let toolCalls = 0;
  const countTool: typeof onTool = onTool ? (ev) => { if (ev.type === "end") toolCalls++; onTool(ev); } : undefined;
  const emit = (result: AgentResult | null, err?: unknown) => {
    const interrupted = err instanceof Error && err.name === "AbortError";
    this.deps.pluginManager.runOnTurnEnd(
      { logger: this.deps.logger, sessionManager: this.deps.sessionManager?.getActiveMeta(), contextManager: this.deps.contextManager },
      { success: !!result && result.success !== false && !err,
        durationMs: Date.now() - startedAt,
        textLength: (result?.text || "").length,
        toolCalls, interrupted: interrupted || undefined },
    );
  };
  try {
    const result = this.deps.config.moe?.enabled
      ? await runWithMoE({...}, input, () => this.executeSingleAgentLoop(input, onChunk, onMeta, countTool, onPhase), { onMeta, onTool: countTool, onPhase })
      : await this.executeSingleAgentLoop(input, onChunk, onMeta, countTool, onPhase);
    emit(result);
    return result;
  } catch (err) {
    emit(null, err);
    throw err;
  }
}
```

- [ ] **Step 4:** PASS + регресс `bunx vitest run tests/core` → green
- [ ] **Step 5:** commit `feat(core): dispatch onTurnEnd at end of Agent.run (single + MoE paths)`

### Task 4: Мост в Repl (+ картинки)

**Files:**
- Modify: `src/cli/repl.ts`
- Test: `tests/cli/repl-bridge.test.ts`

- [ ] **Step 1: failing test** на экспортируемую фабрику (не требуя TTY):

```typescript
import { createHostBridge } from "../../src/cli/repl";

describe("createHostBridge", () => {
  it("rejects when busy, attaches images then runs", async () => {
    let busy = false; const imgs: string[] = []; let ran = "";
    const b = createHostBridge({
      isBusy: () => busy,
      addPendingImage: (u) => imgs.push(u),
      runAgent: async (t) => { ran = t; },
      interruptRun: () => {},
    });
    await expect(b.submit("x")).resolves.toBeUndefined(); // idle
    busy = true;
    await expect(b.submit("y")).rejects.toThrow(/busy/i);
    await expect(b.interrupt()).resolves.toBeUndefined();
    busy = false;
    await b.submit("go", { images: ["data:image/png;base64,AAA"] });
    expect(imgs).toEqual(["data:image/png;base64,AAA"]);
    expect(ran).toBe("go");
  });
});
```

- [ ] **Step 2:** FAIL → **Step 3: implement** в `repl.ts`:

```typescript
export function createHostBridge(opts: {
  isBusy: () => boolean;
  addPendingImage: (dataUrl: string) => void;
  runAgent: (text: string) => Promise<unknown>;
  interruptRun: () => void;
}): HostBridge {
  return {
    isBusy: opts.isBusy,
    async submit(text, o) {
      if (opts.isBusy()) throw new Error("agent is busy");
      for (const url of o?.images ?? []) opts.addPendingImage(url);
      await opts.runAgent(text);
    },
    interrupt() { if (opts.isBusy()) opts.interruptRun(); },
  };
}
```

Wire в конце конструктора Repl:

```typescript
if (pluginManager) {
  pluginManager.setHostBridge(createHostBridge({
    isBusy: () => this.agentRunning,
    addPendingImage: (url) => {
      this.agent.contextManager?.addPendingImage?.({ type: "image_url", image_url: { url } });
    },
    runAgent: (text) => this.runAgent(text),
    interruptRun: () => this.agent.shutdown(),
  }));
}
```

Single-run mode моста не получает (pluginManager без setHostBridge) → POST вернёт 503 no_bridge.
- [ ] **Step 4:** PASS → **Step 5:** commit `feat(cli): wire HostBridge in REPL (messages + images + interrupt via web)`

### Task 5: Каркас плагина (state/util/plugin entry)

**Files:** Create `examples/plugins/web-ui/{state.ts,util.ts,plugin.ts}`

- [ ] **Step 1:** `state.ts` — клиенты SSE, `broadcast(type,data)` (enqueue+flush паттерн trace-server, коалесинг 350ms для text/meta), конфиги env: `HOST=127.0.0.1`, `MAX_CLIENTS=5`, `MAX_MESSAGE_CHARS=32000`, `MAX_IMAGE_BYTES=6_000_000`, `MAX_IMAGES=3`, `state.busy`.
- [ ] **Step 2:** `util.ts` — порт `clip/safeJson/scrub/summarizeArgs` из `examples/plugins/trace-server/util.ts` (переименование, без изменений логики).
- [ ] **Step 3:** `plugin.ts` — скелет AgentPlugin: `name:"web-ui"`, `version:"0.1.0"`, `minMmaVersion:"0.51.0"`; `onSessionStart` захватывает ctx (logger/sessionManager/contextManager/hostBridge) и стартует сервер; `onSessionEnd` останавливает. Ассеты читаются verbatim через `import.meta.url` (кандидаты-пути как у trace-server).
- [ ] **Step 4:** commit `feat(examples): web-ui plugin skeleton (state/util/entry)`

### Task 6: server.ts — static + SSE

**Files:** Create `server.ts`; Test `tests/web-ui-server.test.ts` (реальный сервер на порту 0 + fetch)

- [ ] **Step 1: failing tests**: `GET /`→200 html; `/app.js`→200 js; неизвестный путь→404; `/events` при cap→503; SSE-коннект получает `event: session`.
- [ ] **Step 2:** FAIL → **Step 3:** реализация (порт handleRequest/startServer/stopServer из trace-server/server.ts + роуты `/api/*` под auth-миддлеварой `checkAuth(req)`).
- [ ] **Step 4:** PASS → **Step 5:** commit `feat(examples): web-ui server (static assets + SSE stream)`

### Task 7: history.ts + GET /api/state

**Files:** Create `history.ts`, `plans-snap.ts`; дополнить `server.ts` и тесты

- [ ] **Step 1: failing tests**: фикстурный временный `history.jsonl` (5 сообщений) → `/api/state.history` содержит последние N, поля `{role,text,ts}`; нет файла → пустой массив; busy-флаг отражается; план читается из `<dir>/.mma/plans/active.json`.
- [ ] **Step 2:** FAIL → **Step 3:** `history.readHistoryTail(sessionsDir,id,tail=30)`: парсинг JSONL с устойчивостью к битым строкам; путь сессии: `<configDir>/sessions/<id>/history.jsonl` (id из meta). `plans-snap.readPlansSnapshot(projectDir)` — порт plans.ts (read-only, без polling; poll на клиенте).
- [ ] **Step 4:** PASS → **Step 5:** commit `feat(examples): web-ui /api/state snapshot (session, plan, history tail)`

### Task 8: POST /api/message + /api/interrupt

**Files:** `server.ts` (+gateway-логика в plugin.ts/state.ts); дополнить тесты

- [ ] **Step 1: failing tests** матрицей:
  - idle + валидный `{text:"hi"}` → 202, `bridge.submit` вызван с ("hi", undefined-images)
  - busy → 409; отсутствие bridge → 503; текст >32KB → 413; невалидный JSON/пустой текст → 400
  - images: 4 шт → 400; не-dataURL → 400; >6MB → 413; валидные → переданы в submit
  - токен задан: без заголовка → 401, с заголовком → 202
  - rate-limit: два POST подряд <500ms → 429 (injectable clock)
  - `/api/interrupt` idle → 409, busy → 200 и `bridge.interrupt()` вызван
  - секреты (`sk-…`) в args/output вычищены scrub'ом в SSE-событиях
- [ ] **Step 2:** FAIL → **Step 3:** implement: body-read с капом, `validateMessageBody()`, fire-and-forget `bridge.submit(...)` c `.then/.catch(broadcast error)`, `state.busy=true` сразу после accept (race-free), очистка в `turn_end`.
- [ ] **Step 4:** PASS → **Step 5:** commit `feat(examples): web-ui message/interrupt endpoints (auth, caps, rate limit)`

### Task 9: Фронтенд (page.html/styles.css/app.js)

**Files:** Create три ассета. Тестов нет (статика); проверка smoke'ом + вручную.

- [ ] **Step 1: page.html** — layout: header (session/model/provider/tokens/cost/connection dot), main grid (chat column + right panel: план checklist, контекст-бар), input zone (textarea, кнопки Send/Stop, превью-тумбы картинок, drop-overlay).
- [ ] **Step 2: styles.css** — тёмная тема в духе trace-server (моноширинный, приглушённые акценты), collapsible tool cards (`details/summary`), user/assistant bubble-less различие маркерами.
- [ ] **Step 3: app.js** — поведение:
  - `EventSource("/events")`; reconnect с backoff; события мапятся в DOM-узлы (tool cards по `toolCallId`)
  - `loadState()` при старте: рендер history-хвоста, плана, session header
  - busy-gating: `turn_end`/409 → enable input; accepted → disable
  - отправка: `fetch("/api/message",{method:"POST",...})`; Enter=send, Shift+Enter=newline
  - Stop: `POST /api/interrupt`
  - картинки: input[type=file multiple]+dnd → `downscale(file)` через canvas (max side 800, JPEG 0.6) → data URL в очередь; лимит 3; тумбы с удалением
  - лёгкий inline-markdown: fenced code, inline code, bold, links (escape-first)
  - poll `/api/state` раз в 5s только когда вкладка hidden→visible (обновление плана)
- [ ] **Step 4:** commit `feat(examples): web-ui chat frontend (streaming, tools, plan, images, stop)`

### Task 10: Smoke e2e + docs + гейты

**Files:** Create `_testing/web-ui-smoke.ts`; Modify `docs/plugins.md`, `AGENTS.md`

- [ ] **Step 1:** smoke по образцу `_testing/trace-server-smoke.ts`: импорт плагина, мок-ctx (stub hostBridge, temp sessions dir с фикстурой истории, tmp projectDir с active.json), `onSessionStart` → fetch `/api/state` (история+план на месте) → POST message → assert stub-bridge получил текст → SSE получил `turn_end` → `/api/interrupt` 409 в idle → `onSessionEnd` сервер закрыт.
- [ ] **Step 2:** `bun _testing/web-ui-smoke.ts` → все проверки зелёные.
- [ ] **Step 3:** `docs/plugins.md`: секции «Host Bridge» (как получить/использовать в своём плагине) и «onTurnEnd» (таблица хуков обновлена).
- [ ] **Step 4:** AGENTS.md: Plugins section (строки таблицы хуков + упоминание web-ui), черновик записи версии 0.51.0.
- [ ] **Step 5:** Гейты: `bun test` (полный suite) + `bunx tsc --noEmit` → чисто.
- [ ] **Step 6:** commit `docs: web-ui plugin guide (HostBridge, onTurnEnd) + AGENTS.md update`

## Ручной браузерный чеклист (после Task 10)

1. `bun run mma` в проекте с установленным плагином → баннер с URL → авто-открытие.
2. Отправить сообщение из браузера → ответ печатается И в терминале (единый путь runAgent), и в вебе.
3. Во время прогона ввод заблокирован; Stop прерывает (аналог double-Esc).
4. Перетащить картинку → тумба → отправить → модель видит изображение (vision-модель).
5. Обновить страницу посреди сессии → история/план восстановлены из /api/state.
6. Терминал продолжает работать параллельно; одновременный ввод с двух сторон невозможен (single-flight).

## Риски / примечания

- **Vision:** не-vision модель может проигнорировать/ошибиться на картинках — поведение идентично существующему `/image` в REPL, отдельного гейтинга в MVP нет.
- **Дистрибуция:** examples/ не входит в npm files[] — установка копированием папки (как trace-server). Опционально позже: copy-assets → dist/plugins/.
- **i18n:** строки фронтенда в ассетах (en) — осознанное исключение из правила №8 до появления словаря, отдаваемого сервером (фаза 2).
- **Bun/node:http:** связка доказана trace-server (работает и под Bun, и в Node-dist).
