// "Model & provider" settings panel: one persistent active-turn summary plus
// four focused tabs (providers / models / performance / capabilities). Kept out
// of `providers.ts` so neither file crosses the 300-line ceiling, and so
// provider-list helpers/form openers stay owned by that module (deps injection,
// no import cycle).
import { el, icon } from "../dom.js";
import { t } from "../i18n.js";
import { settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { contextLabel } from "../format.js";
import { PANEL_SECTIONS } from "./controls.js";
import { chip, renderSectionsInto, settingsSection } from "./panels.js";
import { postConfig, loadModels, ensureModelsLoaded } from "./write.js";
import { capabilityEditButton } from "./model-capabilities-form.js";
import { providerIcon } from "./provider-icons.js";

export interface ModelPanelDeps {
  /** Provider entries in display order (live config wins over the snapshot). */
  entries: () => Dict[];
  /** Entry display name (`label` → `type` → `—`). */
  providerName: (p: Dict) => string;
  /** One-line provider meta (type, context, rpm/parallel). */
  providerMeta: (p: Dict) => string;
  /** Open the add/edit provider dialog. */
  openForm: (mode: string, entry: Dict | null) => void;
  /** Confirm, then delete a non-active provider and refresh the list/config. */
  deleteProvider: (name: string) => void;
}

let deps: ModelPanelDeps = {
  entries: () => [],
  providerName: () => "—",
  providerMeta: () => "",
  openForm: () => {},
  deleteProvider: () => {},
};

export function initModelPanel(d: ModelPanelDeps): void {
  deps = d;
}

const TABS: Array<[string, string]> = [
  ["providers", "web.settings.tab_providers"],
  ["models", "web.settings.tab_models"],
  ["performance", "web.settings.tab_performance"],
  ["capabilities", "web.settings.tab_capabilities"],
];

// Survives re-renders (config writes, active-switch) so the user stays on the
// tab they opened instead of being thrown back to Providers.
let activeTab = "providers";

function pane(name: string): HTMLElement {
  const box = el("div", "model-pane");
  box.setAttribute("role", "tabpanel");
  box.dataset.pane = name;
  return box;
}

/** Active provider entry, resolved against the live config's active name. */
function activeEntry(entries: Dict[], activeName: string): Dict | null {
  return entries.find((e) => deps.providerName(e) === activeName) || null;
}

/** Persistent summary: what is actually running right now. */
function activeCard(cfg: Dict, entries: Dict[], activeName: string, select: (k: string) => void): HTMLElement {
  const card = settingsSection("web.settings.active_model");
  card.el.classList.add("master-card");
  const entry = activeEntry(entries, activeName);
  const row = el("div", "model-active");
  const main = el("div", "model-active-main");
  const model = cfg.model ? String(cfg.model) : t("web.settings.no_active_model");
  const name = el("span", "m-name", model);
  name.title = model;
  main.appendChild(name);
  // Контекстное окно — свойство активной модели (его даёт проба под неё), а не
  // провайдера «вообще». Модель не выбрана — контекста нет: показывать число от
  // прошлой модели значит выдавать память за факт.
  const ctx = !cfg.model
    ? ""
    : entry && entry.contextWindow
      ? Math.round(Number(entry.contextWindow) / 1024) + "K"
      : contextLabel();
  const meta = [activeName || t("web.settings.no_active_provider"), ctx].filter(Boolean).join(" · ");
  main.appendChild(el("span", "m-meta", meta));
  // Инвариант: не выдаём чужую модель за рабочую. Список нового провайдера
  // получен и модели в нём нет — карточка обязана это сказать. Пока список
  // грузится или провайдер не ответил, модель тоже не подтверждена: помечаем
  // это, а не показываем её как проверенно рабочую.
  const known = settings.models.map(String);
  const hasModel = !!cfg.model;
  let caveat: string | null = null;
  if (hasModel && (settings.modelsStatus === "loading" || settings.modelsStatus === "idle")) {
    caveat = t("web.settings.model_checking");
  } else if (hasModel && settings.modelsStatus === "error") {
    caveat = t("web.settings.model_unverified");
  } else if (hasModel && settings.modelsStatus === "ready" && known.length === 0) {
    // Провайдер ответил, но списка нет: подтвердить модель нечем.
    caveat = t("web.settings.model_unverified_empty");
  } else if (
    hasModel &&
    settings.modelsStatus === "ready" &&
    known.length > 0 &&
    known.indexOf(String(cfg.model)) === -1
  ) {
    caveat = t("web.settings.model_not_in_provider");
  }
  if (caveat) {
    // Неподтверждённое имя не должно выглядеть как рабочая модель: гасим его.
    name.classList.add("dim");
    main.appendChild(el("span", "m-meta dim", caveat));
  }
  row.appendChild(main);

  const actions = el("div", "model-active-actions");
  actions.appendChild(chip(t("web.settings.change_model"), "", () => select("models")));
  actions.appendChild(
    chip(t("web.settings.edit_provider"), "", () =>
      deps.openForm(entry ? "edit" : "add", entry)),
  );
  row.appendChild(actions);
  card.body.appendChild(row);
  return card.el;
}

function providersPane(entries: Dict[], activeName: string, sections: Dict[]): HTMLElement {
  const box = pane("providers");
  const head = el("div", "model-pane-actions");
  const addBtn = el("button", "sec-add");
  addBtn.type = "button";
  addBtn.setAttribute("aria-haspopup", "dialog");
  addBtn.appendChild(icon("plus"));
  addBtn.appendChild(el("span", "", t("web.settings.add_provider")));
  addBtn.addEventListener("click", () => deps.openForm("add", null));
  head.appendChild(addBtn);
  box.appendChild(head);

  const list = el("div", "provider-list");
  entries.forEach((entry) => {
    const name = deps.providerName(entry);
    const active = name === activeName;
    const item = el("div", "provider-item" + (active ? " active" : ""));
    const itemHead = el("div", "p-head");
    itemHead.append(providerIcon(entry.type, name), el("span", "p-name", name));
    if (active) itemHead.appendChild(el("span", "badge on", t("web.settings.active")));
    item.appendChild(itemHead);
    const meta = deps.providerMeta(entry);
    if (meta) item.appendChild(el("div", "p-meta", meta));
    const actions = el("div", "p-actions");
    if (!active) {
      actions.appendChild(
        chip(t("web.settings.provider_make_active"), "", () => {
          void postConfig("provider.active", name, true);
        }),
      );
    }
    actions.appendChild(chip(t("web.settings.edit"), "", () => deps.openForm("edit", entry)));
    if (!active) {
      actions.appendChild(
        chip(t("web.settings.delete"), "danger", () => {
          void deps.deleteProvider(name);
        }),
      );
    }
    item.appendChild(actions);
    list.appendChild(item);
  });
  if (!entries.length) list.appendChild(el("div", "placeholder", t("web.settings.providers_empty")));
  box.appendChild(list);
  renderSectionsInto(box, sections);
  return box;
}

/** Empty-state text: loading, provider failure and a truly empty list differ. */
function modelsEmptyText(): string {
  if (settings.modelsStatus === "loading" || settings.modelsStatus === "idle") {
    return t("web.settings.models_loading");
  }
  if (settings.modelsStatus === "error") return t("web.settings.models_error");
  return settings.models.length ? t("web.settings.no_matches") : t("web.settings.no_models");
}

function modelsPane(cfg: Dict, activeName: string): HTMLElement {
  // Opening the panel is a natural retry point: boot/SSE may have been missed
  // (e.g. the server restarted while this page stayed open).
  ensureModelsLoaded();
  const box = pane("models");
  const search = el("input", "searchbox");
  search.placeholder = t("web.settings.search_models");
  search.setAttribute("aria-label", t("web.settings.search_models"));
  box.appendChild(search);
  if (activeName) {
    box.appendChild(el("div", "p-meta", t("web.settings.models_of_provider", { provider: activeName })));
  }
  const list = el("div", "model-list");
  box.appendChild(list);
  const draw = () => {
    list.textContent = "";
    const q = search.value.trim().toLowerCase();
    const models = settings.models.filter((m) => !q || String(m).toLowerCase().indexOf(q) !== -1);
    // The active model is the answer to "what am I running?" — keep it on top.
    models.sort((a, b) => Number(b === cfg.model) - Number(a === cfg.model));
    if (!models.length) {
      const empty = el("div", "placeholder", modelsEmptyText());
      // A failed fetch is retryable without reopening settings; the button also
      // makes the state actionable instead of a dead end.
      if (settings.modelsStatus === "error") {
        empty.appendChild(
          chip(t("web.settings.models_retry"), "", () => {
            void loadModels();
          }),
        );
      }
      list.appendChild(empty);
      return;
    }
    models.forEach((m) => {
      const active = m === cfg.model;
      const item = el("div", "model-item" + (active ? " active" : ""));
      const nameEl = el("span", "m-name", String(m));
      nameEl.title = String(m);
      item.appendChild(nameEl);
      if (active) {
        item.appendChild(el("span", "m-meta", contextLabel() + " · " + t("web.settings.active_check")));
      } else {
        item.appendChild(
          chip(t("web.settings.use"), "", () => {
            void postConfig("model", m, true);
          }),
        );
      }
      item.appendChild(capabilityEditButton(String(m)));
      list.appendChild(item);
    });
  };
  search.addEventListener("input", draw);
  draw();
  return box;
}

/** Renders the whole panel into `[data-panel="model"]`. */
export function renderModelPanel(): void {
  const container = document.querySelector<HTMLElement>('[data-panel="model"]');
  if (!container) return;
  container.textContent = "";
  const cfg: Dict = settings.config || {};
  const entries = deps.entries().filter((e) => {
    const n = deps.providerName(e);
    return n && n !== "—";
  });
  const activeName =
    (cfg.provider && (cfg.provider.active || cfg.provider.type)) ||
    (settings.providers && settings.providers.active) ||
    "—";

  const sections = PANEL_SECTIONS.model || [];
  const fallbackSections = sections.filter((s) => s.id === "model.fallback");
  const panes: Record<string, HTMLElement> = {
    providers: providersPane(entries, activeName, fallbackSections),
    models: modelsPane(cfg, activeName),
    performance: pane("performance"),
    capabilities: pane("capabilities"),
  };
  const buttons = new Map<string, HTMLButtonElement>();
  const select = (key: string): void => {
    if (!panes[key]) return;
    activeTab = key;
    for (const [name, node] of Object.entries(panes)) node.hidden = name !== key;
    for (const [name, btn] of buttons) {
      btn.classList.toggle("on", name === key);
      btn.setAttribute("aria-selected", name === key ? "true" : "false");
    }
  };

  container.appendChild(activeCard(cfg, entries, activeName, select));
  const tabs = el("div", "model-tabs");
  tabs.setAttribute("role", "tablist");
  TABS.forEach(([key, labelKey]) => {
    const btn = el("button", "model-tab", t(labelKey));
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.addEventListener("click", () => select(key));
    tabs.appendChild(btn);
    buttons.set(key, btn);
  });
  container.appendChild(tabs);

  // Provider/model catalogs are chronological; runtime/capabilities stay
  // registry-driven so PANEL_SECTIONS remains the single source of truth.
  renderSectionsInto(
    panes.performance,
    sections.filter((s) => s.id !== "model.capabilities" && s.id !== "model.fallback"),
  );
  renderSectionsInto(
    panes.capabilities,
    sections.filter((s) => s.id === "model.capabilities"),
  );
  Object.values(panes).forEach((node) => container.appendChild(node));
  select(activeTab);
}
