# Activity Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline) or
> superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Показывать над строкой ввода в web-UI индикатор занятости агента
(раскладки `off|line|meta|full`, indeterminate-сканер без плана, честный
`done/total` с планом MoE, вспышки на реальные события).

**Architecture:** чисто клиентский модуль `js/rail.js`, владелец состояния rail;
static-разметка в `index.html`, CSS в `styles.css`, wiring в `app.js`/`tabs.js`/`settings.js`.
Бэкенд не меняется; данные — существующие SSE-события + `busy` из `/api/state`.

**Tech Stack:** vanilla ESM (web assets), vitest source-guard tests, i18n en/ru.

**Спека:** `docs/specs/2026-09-27-activity-rail-design.md` (утверждена).
**Ветка:** `fix/chat-internal-diagnostics` (уже активна).

---

### Task 1: Config key `ui.activityRail`

**Files:**
- Modify: `src/config/types.ts` (после `UiConfig.showCompaction`, ~line 247)
- Modify: `src/config/defaults.ts` (`ui`, line 134)
- Modify: `src/config/registry-extra.ts` (после блока `ui.spinner`, line 254)
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`

- [ ] `types.ts` — в `UiConfig`:

```ts
  /**
   * Activity rail above the input line while a turn runs: `line` = compact
   * one-liner (default), `meta` = inside the hint row, `full` = full width,
   * `off` = hidden.
   */
  activityRail: "off" | "line" | "meta" | "full";
```

- [ ] `defaults.ts` — в `ui: {`:

```ts
    activityRail: "line",
```

- [ ] `registry-extra.ts` — сразу после `bool("ui.spinner", ...)`:

```ts
  enumOf("ui.activityRail", "ui", ["off", "line", "meta", "full"] as const, false,
    (c) => c.ui.activityRail ?? "line",
    (c, v) => { c.ui.activityRail = v as "off" | "line" | "meta" | "full"; }),
```

- [ ] i18n (`en.json` рядом с `config.key.ui.spinner`:1510, `ru.json`:1510) —
  добавить в оба файла (паритет строго проверяется `tests/i18n.test.ts`):

```json
  "config.key.ui.activityRail": "activity rail",
  "config.desc.ui.activityRail": "Indicator above the input line while the agent works.",
  "config.enum.off": "off",
  "config.enum.line": "line",
  "config.enum.meta": "hints row",
  "config.enum.full": "full width"
```

ru:

```json
  "config.key.ui.activityRail": "рейка активности",
  "config.desc.ui.activityRail": "Индикатор над строкой ввода, пока агент работает.",
  "config.enum.off": "выкл.",
  "config.enum.line": "строка",
  "config.enum.meta": "в подсказках",
  "config.enum.full": "во всю ширину"
```

(`config.enum.off` может существовать — не дублировать, проверить `rg '"config.enum.off"' src/i18n/en.json`.)

- [ ] Запуск: `bun test tests/i18n.test.ts tests/config-registry-extra.test.ts tests/config-domains.test.ts`
  Expected: PASS (тест паритета требует `config.key/desc.ui.activityRail` в en и ru).

### Task 2: Разметка в `index.html`

**Files:** `src/modules/webui/assets/index.html:39` (внутрь `.input-area`, **перед** `.selectors` — как в утверждённом демо)

- [ ] Вставить:

```html
    <div class="input-area">
      <div class="rail-wrap l-line" id="railWrap" role="status" aria-live="polite" hidden>
        <div class="rail-l1">
          <span class="lab" id="railPhase">✦ thinking</span>
          <span class="s" aria-hidden="true">·</span><span class="time" id="railTime" aria-hidden="true">0.0s</span>
          <span class="s" aria-hidden="true">·</span><span class="st" id="railSteps" aria-hidden="true">no plan</span>
          <span class="right" id="railEsc" aria-hidden="true">Esc — stop</span>
        </div>
        <div class="rl-track" id="railTrack" data-mode="scan">
          <div class="rl-fill" id="railFill"></div>
          <div class="rl-scan"></div>
        </div>
        <div class="rail-l2" aria-hidden="true">
          <span class="tools" id="railTools">0 tools</span>
          <span class="s">·</span><span class="events" id="railEvents">0 events</span>
          <span class="s">·</span><span class="last" id="railLast">—</span>
        </div>
      </div>
      <div class="selectors">
```

(тексты до первой локализации — en-fallback, `rail.js` перезапишет при старте.)

### Task 3: CSS в `styles.css`

**Files:** `src/modules/webui/assets/styles.css` — вставка после `.input-area.dragover`
блока (~line 571), перед секцией sidebar.

- [ ] Скопировать CSS-секцию `№12` из
  `docs/design/ui/demo-activity-rail-chat.html` (строки 28–90) с двумя правками:
  - `body.rl-tool` → `.rail-wrap.phase-tool`, `body.rl-compose` → `.rail-wrap.phase-compose`
    (классы живут на корне rail, не на body);
  - `.rail-l2 .last` — цвет `var(--args)` (есть в демо).
  Добавить строку `.rail-wrap[hidden] { display: none; }` (иначе `display:flex`
  перебивает `hidden`).
- [ ] Проверка: `rg 'rl-track|l-meta' src/modules/webui/assets/styles.css` — блок на месте.

### Task 4: Модуль `js/rail.js`

**Files:** Create: `src/modules/webui/assets/js/rail.js`

- [ ] Написать модуль (полный код):

```js
// Activity rail — the indicator above the composer for the whole `busy` period.
//
// The in-feed `.busy` line clears on the first `text` event; the rail lives
// until the turn ends and shows only what we actually know: phase, elapsed,
// plan progress when a plan exists (MoE), tool/event counters. Without a plan
// the rail is an indeterminate scanner — no invented percentages.

import { t, pluralCount } from "./i18n.js";
import { labelOf } from "./format.js";

const LAYOUTS = ["off", "line", "meta", "full"];

let root = null, trackEl = null, fillEl = null;
let labEl = null, timeEl = null, stepsEl = null, escEl = null;
let toolsEl = null, eventsEl = null, lastEl = null;
let layout = "line";
let busy = false, startedAt = 0;
let tools = 0, events = 0, lastTool = "";
let sawText = false, pendingTool = false;
let plan = null;
let timer = null;

function render() {
  if (!root) return;
  root.hidden = layout === "off" || !busy;
  if (root.hidden) return;
  const phase = pendingTool ? "tool" : sawText ? "composing" : "thinking";
  root.classList.toggle("phase-tool", phase === "tool");
  root.classList.toggle("phase-compose", phase === "composing");
  labEl.textContent = "✦ " + (phase === "tool" ? t("web.rail.working")
    : phase === "composing" ? t("web.rail.composing") : t("web.action.thinking"));
  timeEl.textContent = ((Date.now() - startedAt) / 1000).toFixed(1) + "s";
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  if (steps.length > 0) {
    const done = steps.filter((s) => s && s.status === "done").length;
    trackEl.dataset.mode = "plan";
    fillEl.style.setProperty("--prog", String((done / steps.length) * 100));
    stepsEl.textContent = t("web.rail.step_of", { cur: Math.min(done + 1, steps.length), total: steps.length });
  } else {
    trackEl.dataset.mode = "scan";
    stepsEl.textContent = t("web.rail.no_plan");
  }
  toolsEl.textContent = pluralCount("web.rail.tools", tools);
  eventsEl.textContent = pluralCount("web.rail.events", events);
  lastEl.textContent = lastTool ? t("web.rail.last") + " " + lastTool : t("web.rail.none");
  escEl.textContent = t("web.input.esc");
}

function flash() {
  if (!trackEl || !busy) return;
  trackEl.classList.remove("flash");
  void trackEl.offsetWidth;
  trackEl.classList.add("flash");
}

export function initRail(cfgLayout) {
  root = document.getElementById("railWrap");
  if (!root) return;
  trackEl = root.querySelector(".rl-track");
  fillEl = root.querySelector(".rl-fill");
  labEl = root.querySelector(".lab");
  timeEl = root.querySelector(".time");
  stepsEl = root.querySelector(".st");
  escEl = root.querySelector(".right");
  toolsEl = root.querySelector(".tools");
  eventsEl = root.querySelector(".events");
  lastEl = root.querySelector(".last");
  setLayout(cfgLayout);
  if (!timer) timer = setInterval(render, 250);
}

export function setLayout(next) {
  layout = LAYOUTS.includes(next) ? next : "line";
  if (!root) return;
  root.classList.remove("l-line", "l-meta", "l-full");
  root.classList.add("l-" + layout);
  const inpMeta = document.querySelector(".inp-meta");
  const inputArea = document.querySelector(".input-area");
  if (layout === "meta" && inpMeta && root.parentElement !== inpMeta) {
    inpMeta.prepend(root);
  } else if (layout !== "meta" && inputArea && root.parentElement !== inputArea) {
    const selectors = inputArea.querySelector(".selectors");
    inputArea.insertBefore(root, selectors || inputArea.firstChild);
  }
  render();
}

export function setBusy(on) {
  const next = !!on;
  if (next && !busy) {
    startedAt = Date.now();
    tools = 0; events = 0; lastTool = "";
    sawText = false; pendingTool = false; plan = null;
  }
  busy = next;
  render();
}

export function setPlan(p) {
  plan = p && Array.isArray(p.steps) && p.steps.length > 0 ? p : null;
  render();
}

export function railEvent(kind, name) {
  events += 1;
  if (kind === "tool_start") { pendingTool = true; lastTool = labelOf(name); }
  else if (kind === "tool_end") { pendingTool = false; tools += 1; lastTool = labelOf(name); }
  else if (kind === "text") sawText = true;
  flash();
  render();
}

export function applyRailI18n() { render(); }
```

- [ ] Примечания:
  - `labelOf` экспортируется из `./format.js:41` (тот же mapping, что в ленте);
  - `t(key, {cur,total})` подставляет `{...}` (`i18n.js:14`); `pluralCount(base,n)`
    использует `_one/_few/_many` с `{count}` (`i18n.js:24`);
  - `render()` вызывается по таймеру 250ms — таймер и счётчики обновляются сами.

### Task 5: Wiring

**Files:**
- Modify: `src/modules/webui/assets/app.js`
- Modify: `src/modules/webui/assets/js/tabs.js:649` (`reflectBusy`)
- Modify: `src/modules/webui/assets/js/settings.js:155` (`postConfig`)

- [ ] `app.js` — импорт (рядом с другими `./js/*`):

```js
import { initRail, setBusy as railBusy, setPlan as railPlan, railEvent, applyRailI18n } from "./js/rail.js";
```

- [ ] `app.js` `boot()` — после `await loadConfig();` (line ~248):

```js
  initRail(S.state.config && S.state.config.ui ? S.state.config.ui.activityRail : undefined);
```

- [ ] `app.js` `applyStaticI18n()` — в конец функции: `applyRailI18n();`

- [ ] `app.js` `connectSSE()` — после цикла `for (const [event, fn] of handlers)`
  (line ~137) вставить:

```js
  // Activity rail: its own listeners — feed handlers stay untouched.
  for (const ev of ["tool_start", "tool_end", "text", "plan"]) {
    es.addEventListener(ev, (e) => {
      const d = parse(e);
      if (!d) return;
      if (ev === "plan") railPlan(d);
      else railEvent(ev, d.name);
    });
  }
```

- [ ] `app.js` `renderState(snapshot, busy)` — после `renderPlan(S.state.host.plan);` (line 66):

```js
  railPlan(busy && snapshot ? snapshot.plan : null);
```

(`reflectBusy()` в строке 58 уже дёргается → `setBusy` хук в tabs.js ниже;
busy-переход false→true сбрасывает счётчики, в т.ч. старый plan.)

- [ ] `tabs.js` — импорт + в `reflectBusy()` (конец функции, line 664):

```js
import { setBusy } from "./rail.js";
  setBusy(S.state.busy);
```

- [ ] `settings.js` — импорт + в `postConfig()` после
  `if (S.state.config && r.data.value !== undefined) setPath(...)` (line 160):

```js
    if (key === "ui.activityRail") setLayout(String(r.data.value));
```

(`import { setLayout } from "./rail.js";` — rail.js является листом, циклов нет.)

### Task 6: Панель настроек

**Files:** `src/modules/webui/assets/js/settings-controls.js:424`

- [ ] Строка панели `ui.chat` →
  `keys: ["ui.activityRail", "ui.spinner", "ui.showContextStats", "ui.showCompaction"]`
  (enum-контрол рисуется автоматически по `valueType:"enum"` + подписи
  `config.enum.*` из Task 1).

### Task 7: i18n `web.rail.*`

**Files:** `src/i18n/en.json` (около `web.action.thinking`:1346), `src/i18n/ru.json` (около 1322)

- [ ] en:

```json
  "web.rail.working": "working",
  "web.rail.composing": "composing",
  "web.rail.no_plan": "no plan",
  "web.rail.step_of": "step {cur}/{total}",
  "web.rail.last": "last:",
  "web.rail.none": "—",
  "web.rail.tools_one": "{count} tool",
  "web.rail.tools_many": "{count} tools",
  "web.rail.events_one": "{count} event",
  "web.rail.events_many": "{count} events"
```

- [ ] ru:

```json
  "web.rail.working": "выполняю",
  "web.rail.composing": "пишу",
  "web.rail.no_plan": "без плана",
  "web.rail.step_of": "шаг {cur}/{total}",
  "web.rail.last": "последнее:",
  "web.rail.none": "—",
  "web.rail.tools_one": "{count} тул",
  "web.rail.tools_few": "{count} тула",
  "web.rail.tools_many": "{count} тулов",
  "web.rail.events_one": "{count} событие",
  "web.rail.events_few": "{count} события",
  "web.rail.events_many": "{count} событий"
```

- [ ] Запуск: `bun test tests/i18n.test.ts tests/webui-i18n.test.ts` — PASS.

### Task 8: Source-guard тест

**Files:** `tests/webui-assets.test.ts` (конец файла, внутри общего `describe`)

- [ ] Добавить:

```ts
  it("wires the activity rail above the composer", () => {
    const a = loadAssets();
    expect(a.html).toContain('id="railWrap"');
    expect(a.html).toContain('role="status" aria-live="polite"');
    expect(a.css).toContain(".rail-wrap.l-line");
    expect(a.css).toContain(".rl-track");
    expect(a.css).toContain(".rl-scan");
    expect(js(a)).toContain("initRail(");
    expect(js(a)).toContain("railEvent(");
    expect(js(a)).toContain('["tool_start", "tool_end", "text", "plan"]');
    expect(js(a)).toContain('"ui.activityRail"');
  });
```

- [ ] Запуск: `bun test tests/webui-assets.test.ts` — PASS.

### Task 9: Quality gate

- [ ] `bun run quality` (= typecheck + lint + fallow) — зелёный.
- [ ] `bun test` — полный прогон зелёный.
- [ ] Ручная проверка по п.11 спеки (`bun run web:dev`) — **только если пользователь
  просит**; Playwright e2e — только по явной команде (AGENTS.md).
- [ ] Обновить `CHANGELOG.md` (Unreleased/новый PATCH-раздел, `**webui**:` entry)
  и добавить в `AGENTS.md` короткий пункт в секцию Web UI (расширив раздел 2.x).
- [ ] Не коммитить без явной просьбы пользователя (рабочее дерево содержит
  посторонние изменения).

### Self-review (спека → план)

- Раскладки/режимы/вспышки/lifecycle/a11y → Tasks 2-5 (спека §3).
- Источники данных без бэкенда → Task 5 (SSE + `renderState`/`reflectBusy`).
- `ui.activityRail` + панель settings → Tasks 1, 6.
- i18n en/ru + `config.enum.*` → Tasks 1, 7.
- Граничные случаи (reconnect/off/битый план) → покрыты в rail.js
  (guard на `steps`, `LAYOUTS.includes`, idempotent `setBusy`).
- Тесты → Tasks 1, 7, 8, 9.
- `n.*` из ранних заметок заменён на фактический механизм `config.enum.*`
  (settings.js:228 `enumLabel`).
