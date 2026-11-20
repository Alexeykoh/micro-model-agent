# Web-редактирование возможностей модели — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Позволить редактировать `reasoningStrategy`/`reasoningOff`/`reasoningLevels` (и существующие media-флаги) модели напрямую из `mma web`: кнопка у модели → поп-ап → один `POST /api/config` с немедленным реконфигом провайдера.

**Architecture:** Единый ключ `modelCapabilities` остаётся источником правды. Бэкенд-валидатор расширяется и получает эффект `REBUILD`; фронтенд добавляет диалог над тем же ключом и расширяет существующую таблицу в Capabilities, чтобы оба редактора не теряли поля друг друга. Новых REST/SSE-контрактов и ключей конфига нет.

**Tech Stack:** Bun + TypeScript strict, Bun test (vitest-API), happy-dom для фронтенд-тестов, Biome линтер, веб-ассеты в `src/modules/webui/assets/js/**` (отдельный tsconfig).

---

### Task 1: Валидатор `modelCapabilities` и эффект пересборки

**Files:**
- Modify: `src/config/registry-extra-capabilities.ts:1-55`
- Test: `tests/config-registry-extra.test.ts`

- [ ] **Step 1: Добавить падающие тесты валидатора и эффекта**

В конец `tests/config-registry-extra.test.ts` добавить:

```ts
describe("modelCapabilities overrides", () => {
  it("rebuilds the provider when a capability override is written", () => {
    expect(resolveConfigKey("modelCapabilities")?.effects).toContain("provider.rebuild");
  });

  it("accepts reasoning fields and arbitrary subsets", () => {
    const cfg = freshCfg();
    const raw = JSON.stringify({
      "bonsai-2-27b-pq2": {
        vision: true,
        tools: true,
        reasoningStrategy: "openai-effort",
        reasoningOff: true,
        reasoningLevels: ["low", "medium", "xhigh"],
      },
      "bonsai-2-27b": { reasoningStrategy: "none" },
      "empty-levels": { reasoningLevels: [] },
    });
    expect(setConfigValue(cfg, "modelCapabilities", raw).ok).toBe(true);
    expect(cfg.modelCapabilities?.["bonsai-2-27b-pq2"].reasoningLevels).toEqual([
      "low", "medium", "xhigh",
    ]);
  });

  it("rejects invalid reasoning shapes without changing config", () => {
    const cfg = freshCfg();
    expect(
      setConfigValue(
        cfg,
        "modelCapabilities",
        '{"m":{"reasoningStrategy":"banana"}}',
      ).ok,
    ).toBe(false);
    expect(
      setConfigValue(
        cfg,
        "modelCapabilities",
        '{"m":{"reasoningLevels":[1,2]}}',
      ).ok,
    ).toBe(false);
    expect(
      setConfigValue(
        cfg,
        "modelCapabilities",
        '{"m":{"reasoningOff":"yes"}}',
      ).ok,
    ).toBe(false);
    expect(cfg.modelCapabilities).toEqual({});
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
bun test tests/config-registry-extra.test.ts -t "modelCapabilities overrides"
```
Expected: FAIL — эффект пуст, reasoning-поля отклоняются.

- [ ] **Step 3: Реализовать валидацию и эффект**

В `src/config/registry-extra-capabilities.ts` добавить импорт и хелпер после импортов:

```ts
import { REBUILD } from "./effects";

const REASONING_STRATEGIES = [
  "openai-effort",
  "template-kwarg",
  "prompt-tag",
  "none",
] as const;

function validCapabilityEntry(e: unknown): boolean {
  if (!isRecord(e)) return false;
  for (const key of ["vision", "video", "audio", "pdf", "tools", "reasoningOff"] as const) {
    if (e[key] !== undefined && typeof e[key] !== "boolean") return false;
  }
  if (
    e.reasoningStrategy !== undefined &&
    !REASONING_STRATEGIES.includes(e.reasoningStrategy as (typeof REASONING_STRATEGIES)[number])
  ) {
    return false;
  }
  if (
    e.reasoningLevels !== undefined &&
    !(Array.isArray(e.reasoningLevels) && e.reasoningLevels.every((v) => typeof v === "string"))
  ) {
    return false;
  }
  return true;
}
```

Заменить блок `jsonShape("modelCapabilities", …)` целиком на:

```ts
  {
    ...jsonShape(
      "modelCapabilities",
      "provider",
      (c) => c.modelCapabilities ?? {},
      (c, v) => { c.modelCapabilities = v as AppConfig["modelCapabilities"]; },
      (v) => isRecord(v) && Object.values(v).every(validCapabilityEntry),
    ),
    effects: REBUILD,
  },
```

- [ ] **Step 4: Тесты зелёные**

```bash
bun test tests/config-registry-extra.test.ts
```
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/config/registry-extra-capabilities.ts tests/config-registry-extra.test.ts
git commit -m "feat(config): validate reasoning fields in modelCapabilities and rebuild provider"
```

---

### Task 2: Колонки reasoning в таблице Capabilities

**Files:**
- Modify: `src/config/registry-extra-capabilities.ts` (дескриптор `modelCapabilities`)
- Modify: `src/modules/webui/assets/js/settings/table-editor.ts:125-199`
- Test: `tests/config-registry-extra.test.ts`

- [ ] **Step 1: Падающий тест на метаданные редактора**

Добавить в `describe("registry editor metadata")` в `tests/config-registry-extra.test.ts`:

```ts
  it("declares reasoning columns for the modelCapabilities table", () => {
    const editor = resolveConfigKey("modelCapabilities")?.editor;
    expect(editor?.layout).toBe("stack");
    const columns = (editor?.columns ?? []) as Array<Record<string, unknown>>;
    expect(columns.map((c) => c.key)).toEqual([
      "name",
      "vision",
      "video",
      "audio",
      "pdf",
      "tools",
      "reasoningStrategy",
      "reasoningOff",
      "reasoningLevels",
    ]);
    const strategy = columns.find((c) => c.key === "reasoningStrategy");
    expect(strategy?.options).toEqual([
      "openai-effort", "template-kwarg", "prompt-tag", "none",
    ]);
    expect(columns.find((c) => c.key === "reasoningOff")?.type).toBe("bool");
    expect(columns.find((c) => c.key === "reasoningLevels")?.array).toBe(true);
  });
```

- [ ] **Step 2: Прогнать тест (FAIL)**

```bash
bun test tests/config-registry-extra.test.ts -t "reasoning columns"
```
Expected: FAIL — колонок нет.

- [ ] **Step 3: Добавить колонки в дескриптор**

В `jsonShape("modelCapabilities", …)` (после Task 1 — внутри spread-объекта) передать пятым аргументом редактор:

```ts
      (v) => isRecord(v) && Object.values(v).every(validCapabilityEntry),
      {
        kind: "table",
        layout: "stack",
        columns: [
          { key: "name" },
          { key: "vision", type: "bool", optional: true },
          { key: "video", type: "bool", optional: true },
          { key: "audio", type: "bool", optional: true },
          { key: "pdf", type: "bool", optional: true },
          { key: "tools", type: "bool", optional: true },
          {
            key: "reasoningStrategy",
            optional: true,
            options: [...REASONING_STRATEGIES],
          },
          { key: "reasoningOff", type: "bool", optional: true },
          { key: "reasoningLevels", optional: true, array: true },
        ],
      },
```

- [ ] **Step 4: Поддержать статические `options` в `table-editor.ts`**

В `inputFor()` сразу после блока `if (col.optionsSource) { … return sel; }` и до `const input = el("input");` вставить:

```ts
    // Static option list (e.g. reasoningStrategy): no network, no live source.
    if (Array.isArray(col.options) && !col.optionsSource) {
      const cur = v == null ? "" : String(v);
      const sel = el("select");
      const none = el("option", "", "—");
      none.value = "";
      sel.appendChild(none);
      const seen = new Set([""]);
      for (const opt of col.options as string[]) {
        if (seen.has(opt)) continue;
        seen.add(opt);
        const op = el("option", "", opt);
        op.value = opt;
        sel.appendChild(op);
      }
      if (cur && !seen.has(cur)) {
        const op = el("option", "", cur);
        op.value = cur;
        sel.appendChild(op);
      }
      sel.value = cur;
      sel.setAttribute("aria-label", `${row.name}: ${ctx.fieldLabel(col.key)}`);
      sel.addEventListener("change", () => {
        if (sel.value) row.val[col.key] = sel.value;
        else delete row.val[col.key];
        sync();
      });
      return sel;
    }
```

`build()` и `writeValue()` трогать не нужно: для строковых колонок они уже работают с `String(v)` и массивами через `array: true`.

- [ ] **Step 5: Проверки**

```bash
bun test tests/config-registry-extra.test.ts tests/webui-config-extra.test.ts
bun run typecheck:frontend
```
Expected: PASS; `modelCapabilities` по-прежнему ровно в одной секции `PANEL_SECTIONS.model`.

- [ ] **Step 6: Коммит**

```bash
git add src/config/registry-extra-capabilities.ts src/modules/webui/assets/js/settings/table-editor.ts tests/config-registry-extra.test.ts
git commit -m "feat(web): edit reasoning capabilities in the model capabilities table"
```

---

### Task 3: i18n-ключи (en/ru)

**Files:**
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`
- Test: `tests/i18n.test.ts`, `tests/webui-i18n.test.ts`

> Порядок выполнения скорректирован: Task 3 выполняется **до** Task 2, потому что
> gate `tests/config-registry-extra.test.ts` требует i18n-метки для каждой новой
> колонки и каждой опции селекта.

- [ ] **Step 1: Исходное состояние**

```bash
bun test tests/i18n.test.ts tests/webui-i18n.test.ts
```
Expected: PASS (новых ключей ещё нет). Гейт симметрии сработает на шаге 5: если ключ добавить только в один словарь, тест упадёт.

- [ ] **Step 2: Добавить ключи в `src/i18n/en.json` после `"config.field.tools"`**

```json
  "config.field.reasoningStrategy": "reasoning strategy",
  "config.field.reasoningOff": "can disable reasoning",
  "config.field.reasoningLevels": "reasoning levels",
```

- [ ] **Step 3: Добавить ключи в `src/i18n/ru.json` после `"config.field.tools"`**

```json
  "config.field.reasoningStrategy": "механизм рассуждений",
  "config.field.reasoningOff": "можно выключить рассуждения",
  "config.field.reasoningLevels": "уровни рассуждений",
```

- [ ] **Step 4: Добавить ключи диалога**

В `en.json` рядом с `"web.settings.save"`:

```json
  "web.settings.model_capabilities.edit": "edit capabilities",
  "web.settings.model_capabilities.title": "Capabilities: {model}",
  "web.settings.model_capabilities.detected": "Detected by provider: {values}",
  "web.settings.model_capabilities.reset": "reset override",
```

В `ru.json` в том же порядке:

```json
  "web.settings.model_capabilities.edit": "возможности",
  "web.settings.model_capabilities.title": "Возможности модели: {model}",
  "web.settings.model_capabilities.detected": "Определено провайдером: {values}",
  "web.settings.model_capabilities.reset": "сбросить оверрайд",
```

Также добавить метки опций селекта (их требует тот же гейт реестра):

`en.json` / `ru.json` рядом с `"config.enum.quiet"`:

```json
  "config.enum.openai-effort": "openai effort",
  "config.enum.template-kwarg": "template kwarg",
  "config.enum.prompt-tag": "prompt tag",
  "config.enum.none": "none",
```

```json
  "config.enum.openai-effort": "поле reasoning_effort",
  "config.enum.template-kwarg": "параметр шаблона",
  "config.enum.prompt-tag": "тег в промпте",
  "config.enum.none": "нет",
```

- [ ] **Step 5: Проверки и коммит**

```bash
bun test tests/i18n.test.ts tests/webui-i18n.test.ts tests/config-registry-extra.test.ts
git add src/i18n/en.json src/i18n/ru.json
git commit -m "i18n: labels for per-model capability editor"
```
Expected: PASS.

---

### Task 4: Модуль поп-апа и чистые функции сборки записи

**Files:**
- Create: `src/modules/webui/assets/js/settings/model-capabilities-form.ts`
- Test: `tests/webui-model-capabilities-form.test.ts`

- [ ] **Step 1: Падающий тест чистых функций**

Создать `tests/webui-model-capabilities-form.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

setupHappyDom();

const { buildModelCapabilities } = await import(
  "../src/modules/webui/assets/js/settings/model-capabilities-form.js"
);

describe("model capabilities form value", () => {
  const all = {
    "other-model": { vision: true },
    "bonsai-2-27b-pq2": { tools: false },
  };

  it("replaces only the edited model and drops unset fields", () => {
    const out = buildModelCapabilities(all, "bonsai-2-27b-pq2", {
      vision: true,
      reasoningStrategy: "openai-effort",
      reasoningOff: false,
      reasoningLevels: "low, medium, xhigh",
      tools: false,
    });
    expect(out).toEqual({
      "other-model": { vision: true },
      "bonsai-2-27b-pq2": {
        vision: true,
        reasoningStrategy: "openai-effort",
        reasoningLevels: ["low", "medium", "xhigh"],
      },
    });
  });

  it("removes the override when the form is empty", () => {
    expect(buildModelCapabilities(all, "bonsai-2-27b-pq2", {})).toEqual({
      "other-model": { vision: true },
    });
  });

  it("does not mutate stored overrides", () => {
    buildModelCapabilities(all, "bonsai-2-27b-pq2", { vision: true });
    expect(all["bonsai-2-27b-pq2"]).toEqual({ tools: false });
  });
});
```

- [ ] **Step 2: Прогнать тест (FAIL)**

```bash
bun test tests/webui-model-capabilities-form.test.ts
```
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать модуль**

Создать `src/modules/webui/assets/js/settings/model-capabilities-form.ts`:

```ts
// Per-model capability editor: one popup form over config.modelCapabilities[model].
// Fields mirror ModelCapabilities (src/config/types.ts); labels come from the
// same config.field.* keys as the Capabilities table.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { session, settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { closeSubDialog, openSubDialog } from "../subdialog.js";
import { postConfig } from "./write.js";

export interface CapabilityField {
  key: string;
  kind: "bool" | "enum" | "list";
  options?: string[];
}

// Mirror of the strategy enum in src/config/types.ts; keep both in sync.
export const CAPABILITY_FIELDS: CapabilityField[] = [
  { key: "vision", kind: "bool" },
  { key: "video", kind: "bool" },
  { key: "audio", kind: "bool" },
  { key: "pdf", kind: "bool" },
  { key: "tools", kind: "bool" },
  {
    key: "reasoningStrategy",
    kind: "enum",
    options: ["openai-effort", "template-kwarg", "prompt-tag", "none"],
  },
  { key: "reasoningOff", kind: "bool" },
  { key: "reasoningLevels", kind: "list" },
];

/** Whole-key value: replace one model's entry, keep every other override. */
export function buildModelCapabilities(
  all: Dict | undefined,
  model: string,
  form: Record<string, unknown>,
): Dict {
  const out: Dict = {};
  for (const [name, entry] of Object.entries(all ?? {})) {
    if (name === model) continue;
    if (entry && typeof entry === "object") out[name] = { ...(entry as Dict) };
  }
  const entry: Dict = {};
  for (const field of CAPABILITY_FIELDS) {
    const value = form[field.key];
    if (field.kind === "bool") {
      if (value === true) entry[field.key] = true;
    } else if (field.kind === "enum") {
      const text = typeof value === "string" ? value.trim() : "";
      if (text) entry[field.key] = text;
    } else {
      const levels = Array.isArray(value)
        ? value.map(String)
        : typeof value === "string"
          ? value.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
      if (levels.length) entry[field.key] = levels;
    }
  }
  if (Object.keys(entry).length) out[model] = entry;
  return out;
}

/** Discovery hint: GET /api/models carries capabilities for the active model only. */
export function detectedHint(model: string): string | null {
  const cfg = settings.config;
  if (!cfg || cfg.model !== model) return null;
  const caps = session.capabilities;
  const reasoning = session.reasoning as Dict | undefined;
  const parts: string[] = [];
  for (const key of ["vision", "video", "audio", "pdf", "tools"] as const) {
    if (caps?.[key] === true) parts.push(key);
  }
  if (reasoning?.strategy && reasoning.strategy !== "none") {
    parts.push("reasoning: " + String(reasoning.strategy));
    if (Array.isArray(reasoning.levels) && reasoning.levels.length) {
      parts.push("levels: " + reasoning.levels.join("/"));
    }
  }
  return parts.length ? parts.join(" · ") : null;
}

/** Compact trigger placed on each row of the Models tab. */
export function capabilityEditButton(model: string): HTMLButtonElement {
  const button = el("button", "chip", t("web.settings.model_capabilities.edit"));
  button.type = "button";
  button.dataset.capEdit = "1";
  button.addEventListener("click", () => openModelCapabilitiesDialog(model));
  return button;
}

/** Open the nested dialog for one model. Save/Reset post once, then close. */
export function openModelCapabilitiesDialog(model: string): void {
  const all = (settings.config?.modelCapabilities ?? {}) as Dict;
  const stored = all[model];
  const current: Dict = stored && typeof stored === "object" ? { ...(stored as Dict) } : {};
  const form: Record<string, unknown> = {};
  const body = el("div", "caps-form");

  const hint = detectedHint(model);
  if (hint) {
    body.appendChild(
      el("div", "p-meta", t("web.settings.model_capabilities.detected", { values: hint })),
    );
  }

  for (const field of CAPABILITY_FIELDS) {
    const label = t("config.field." + field.key);
    const row = el("label", "table-field");
    row.appendChild(el("span", "table-field-label", label));
    let input: HTMLInputElement | HTMLSelectElement;
    if (field.kind === "bool") {
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = current[field.key] === true;
      input = cb;
    } else if (field.kind === "enum") {
      const sel = el("select");
      const none = el("option", "", t("config.enum.none"));
      none.value = "";
      sel.appendChild(none);
      for (const option of field.options ?? []) {
        const op = el("option", "", option);
        op.value = option;
        sel.appendChild(op);
      }
      sel.value = typeof current[field.key] === "string" ? String(current[field.key]) : "";
      input = sel;
    } else {
      const text = el("input");
      text.type = "text";
      text.placeholder = "low, medium, xhigh";
      text.value = Array.isArray(current[field.key])
        ? current[field.key].join(", ")
        : current[field.key] == null
          ? ""
          : String(current[field.key]);
      input = text;
    }
    input.setAttribute("aria-label", `${model}: ${label}`);
    form[field.key] =
      field.kind === "bool" ? current[field.key] === true : input.value;
    input.addEventListener("change", () => {
      form[field.key] = field.kind === "bool"
        ? (input as HTMLInputElement).checked
        : input.value;
    });
    row.appendChild(input);
    body.appendChild(row);
  }

  const actions = el("div", "model-pane-actions");
  const save = el("button", "btn", t("web.settings.save"));
  save.type = "button";
  save.addEventListener("click", () => {
    void postConfig("modelCapabilities", buildModelCapabilities(all, model, form), true).then(
      (ok) => { if (ok) closeSubDialog(); },
    );
  });
  const reset = el("button", "btn", t("web.settings.model_capabilities.reset"));
  reset.type = "button";
  reset.addEventListener("click", () => {
    void postConfig("modelCapabilities", buildModelCapabilities(all, model, {}), true).then(
      (ok) => { if (ok) closeSubDialog(); },
    );
  });
  const cancel = el("button", "btn", t("web.settings.cancel"));
  cancel.type = "button";
  cancel.addEventListener("click", () => closeSubDialog());
  actions.append(save, reset, cancel);
  body.appendChild(actions);

  openSubDialog(t("web.settings.model_capabilities.title", { model }), body);
}
```

- [ ] **Step 4: Тесты и линт**

```bash
bun test tests/webui-model-capabilities-form.test.ts
bun run typecheck:frontend
```
Expected: PASS. `assets/**` намеренно вне Biome (правило репо), поэтому линтер на этот файл не гоняем.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/webui/assets/js/settings/model-capabilities-form.ts tests/webui-model-capabilities-form.test.ts
git commit -m "feat(web): per-model capabilities dialog with merge-safe save"
```

---

### Task 5: Кнопка у модели в Models tab + DOM-тест

**Files:**
- Modify: `src/modules/webui/assets/js/settings/model-panel.ts:181-236`
- Test: `tests/webui-model-capabilities-dialog-dom.test.ts` (новый)

- [ ] **Step 1: Падающий DOM-тест**

Создать `tests/webui-model-capabilities-dialog-dom.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(`
  <div data-panel="model"></div>
  <div id="subOverlay" class="">
    <div id="subHost"></div>
    <span id="subTitle"></span>
    <button id="closeSub"></button>
  </div>
  // No #saveIndicator here: setIndicator() owns a 2.4s global queue and would
  // leak a toast into other DOM test files sharing the module instance.
`);

const i18n = await import("../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = {
  en: {
    "web.settings.save": "save",
    "web.settings.cancel": "cancel",
    "config.enum.none": "—",
    "web.settings.model_capabilities.reset": "reset override",
    "web.settings.model_capabilities.detected": "Detected by provider: {values}",
    "web.settings.model_capabilities.edit": "edit capabilities",
  },
};
const store = await import("../src/modules/webui/assets/js/store.js");
const { renderModelPanel } = await import(
  "../src/modules/webui/assets/js/settings/providers.js"
);
const form = await import(
  "../src/modules/webui/assets/js/settings/model-capabilities-form.js"
);

function mount(): void {
  store.settings.config = {
    model: "active-model",
    modelCapabilities: { active-model: { vision: true } },
    provider: { type: "openai-compat", active: "llama.cpp" },
  } as never;
  store.settings.models = ["active-model", "bonsai-2-27b-pq2"];
  store.settings.modelsStatus = "ready";
  store.settings.modelsReady = true;
  store.settings.registry = [];
  store.settings.providers = {
    active: "llama.cpp",
    entries: [{ label: "llama.cpp", type: "openai-compat", baseUrl: "http://localhost:8080/v1" }],
    presets: [],
  };
  store.session.capabilities = null;
  store.session.reasoning = undefined;
  renderModelPanel();
}

const tick = (): Promise<void> => new Promise((r) => win.setTimeout(r, 10));

describe("per-model capabilities dialog", () => {
  afterEach(() => {
    store.session.capabilities = null;
    store.session.reasoning = undefined;
  });

  it("opens from the model row with the stored value prefilled", () => {
    mount();
    const row = [...document.querySelectorAll<HTMLElement>(".model-item")].find(
      (n) => n.querySelector(".m-name")?.textContent === "bonsai-2-27b-pq2",
    );
    const button = row?.querySelector<HTMLElement>("[data-cap-edit]");
    expect(button).toBeTruthy();
    button?.click();
    expect(document.getElementById("subOverlay")?.classList.contains("open")).toBe(true);
    const fields = [...document.querySelectorAll<HTMLElement>("#subHost .caps-form input, #subHost .caps-form select")];
    expect(fields.length).toBe(8);
    const strategy = document.querySelector<HTMLSelectElement>(
      '#subHost select[aria-label="bonsai-2-27b-pq2: reasoningStrategy"]',
    );
    expect(strategy).toBeTruthy();
    expect(strategy?.value).toBe("");
  });

  it("posts the merged whole-key record and closes only on success", async () => {
    const calls: Array<{ key: string; value: unknown }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (!String(url).endsWith("/api/config")) return original(url, init);
      calls.push(JSON.parse(String(init?.body ?? "{}")) as { key: string; value: unknown });
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      mount();
      form.openModelCapabilitiesDialog("bonsai-2-27b-pq2");
      const levels = document.querySelector<HTMLInputElement>(
        '#subHost input[aria-label="bonsai-2-27b-pq2: reasoningLevels"]',
      );
      if (!levels) throw new Error("levels input missing");
      levels.value = "low, xhigh";
      levels.dispatchEvent(new win.Event("change"));
      const save = [...document.querySelectorAll<HTMLElement>("#subHost button")]
        .find((b) => b.textContent === "save");
      if (!save) throw new Error("save button missing");
      save.click();
      await tick();
      expect(calls).toHaveLength(1);
      expect(calls[0].key).toBe("modelCapabilities");
      expect(calls[0].value).toEqual({
        "active-model": { vision: true },
        "bonsai-2-27b-pq2": { reasoningLevels: ["low", "xhigh"] },
      });
      expect(document.getElementById("subOverlay")?.classList.contains("open")).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("shows the discovered hint only for the active model", () => {
    store.session.capabilities = { vision: true };
    store.session.reasoning = { strategy: "openai-effort", levels: ["low"] };
    mount();
    form.openModelCapabilitiesDialog("active-model");
    expect(document.getElementById("subHost")?.textContent).toContain(
      "Detected by provider:",
    );
    form.openModelCapabilitiesDialog("bonsai-2-27b-pq2");
    expect(document.getElementById("subHost")?.textContent).not.toContain(
      "Detected by provider:",
    );
  });
});
```

- [ ] **Step 2: Прогнать тест (FAIL)**

```bash
bun test tests/webui-model-capabilities-dialog-dom.test.ts
```
Expected: FAIL — нет кнопки `[data-cap-edit]`.

- [ ] **Step 3: Добавить кнопку в строку модели**

В `model-capabilities-form.ts` добавить триггер (он же владеет кнопкой и держит
`model-panel.ts` под потолком 300 строк):

```ts
export function capabilityEditButton(model: string): HTMLButtonElement {
  const button = el("button", "chip", t("web.settings.model_capabilities.edit"));
  button.type = "button";
  button.dataset.capEdit = "1";
  button.addEventListener("click", () => openModelCapabilitiesDialog(model));
  return button;
}
```

В `src/modules/webui/assets/js/settings/model-panel.ts` после импорта
`postConfig, loadModels, ensureModelsLoaded` добавить:

```ts
import { capabilityEditButton } from "./model-capabilities-form.js";
```

В `modelsPane()` внутри `models.forEach((m) => { … })`, перед `list.appendChild(item);` вставить:

```ts
      item.appendChild(capabilityEditButton(String(m)));
```

- [ ] **Step 4: Тесты зелёные**

```bash
bun test tests/webui-model-capabilities-dialog-dom.test.ts tests/webui-model-panel-dom.test.ts
bun run typecheck:frontend
```
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/webui/assets/js/settings/model-panel.ts tests/webui-model-capabilities-dialog-dom.test.ts
git commit -m "feat(web): edit model capabilities from the Models tab"
```

---

### Task 6: Полная проверка и债-сверка

**Files:** нет (только проверки)

- [ ] **Step 1: Прогнать всю сюиту и гейты**

```bash
bun test
bun run quality
```
Expected: PASS. `quality` не заменяет `bun test` — гоняем оба.

- [ ] **Step 2: Проверить гейты потолков/границ**

`bun run quality` включает `tests/arch/*` (в том числе 300 строк и `module-boundaries`), `tests/output/*`, `tests/i18n.test.ts`, `tests/webui-i18n.test.ts`. Отдельно убедиться, что новый файл ≤300 строк:

```bash
wc -l src/modules/webui/assets/js/settings/model-capabilities-form.ts
```
Expected: ≤300.

- [ ] **Step 3: Живая проверка веба (только если пользователь разрешил Playwright)**

По правилам репо E2E не гоняем без явной команды. Для этого плана достаточно DOM-тестов и `bun test`/`quality`.

- [ ] **Step 4: Итог**

Ветка `feat/web-model-capabilities` готова к слиянию в `dev`. Версия и `CHANGELOG.md` не тронуты.

---

## Self-review (заполняется автором плана)

- **Покрытие спеки:** §2.1 → Task 1; §2.2 → Tasks 4–5; §2.3 → Task 2; §2.4 → Task 3; §4 → Tasks 1–6; §5 → Task 6 / коммиты ветки.
- **Placeholders:** нет; в каждом шаге с кодом приведён полный текст.
- **Типы/имена:** `buildModelCapabilities(all, model, form)` используется одинаково в Task 4 и 5; `openModelCapabilitiesDialog(model)` — в Task 5; `CAPABILITY_FIELDS` — 8 полей, совпадают с колонками Task 2 (кроме ключа-имени).
