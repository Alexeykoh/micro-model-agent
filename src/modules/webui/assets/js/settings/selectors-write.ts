// Composer selector chips + dropdown menus (provider / model / context /
// reasoning). Split out of `write.ts` (rule 6): this module owns the selector
// DOM and reads config through the write funnel, so it imports downward only —
// `write.ts` calls back into `renderSelectors` via `setSelectorRenderer`,
// which keeps the frontend import graph acyclic.
import { el, icon, link } from "../dom.js";
import { t } from "../i18n.js";
import { initPendingWait } from "./pending-wait.js";
import { settings, session, getPath } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { contextLabel, matchesQuery } from "../format.js";
import { closeAllMenus, setSessOpen } from "../core/menus.js";
import { reasoningStatus } from "./reasoning-status.js";
import {
  postConfig,
  loadModels,
  paintSelectorPending,
  setSelectorRenderer,
  openSettingsPanel,
} from "./write.js";

function setSelButton(btn: HTMLElement | null, label: string, value: string): void {
  if (!btn) return;
  btn.textContent = label + ":";
  btn.appendChild(el("b", "", value));
  btn.appendChild(icon("chevron-down"));
  // U19: on a phone the text prefix is hidden (one-row chips), so the full
  // "label: value" must live somewhere: title + accessible name.
  btn.title = label + ": " + value;
  btn.setAttribute("aria-label", btn.title);
}

function menuItem(label: string, sub: string, active: boolean, onClick: () => void): HTMLButtonElement {
  const mi = el("button", "mi" + (active ? " on" : ""));
  mi.type = "button";
  mi.setAttribute("aria-pressed", active ? "true" : "false");
  mi.appendChild(el("span", "", label));
  if (sub) mi.appendChild(el("span", "sub", sub));
  mi.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
    closeAllMenus();
  });
  return mi;
}

// Menu action row (refresh, custom, add…) with an optional leading icon.
function menuAction(label: string, iconName: string | null, onClick: () => void): HTMLButtonElement {
  const mi = el("button", "mi row-mi");
  mi.type = "button";
  if (iconName) mi.appendChild(icon(iconName));
  mi.appendChild(el("span", "", label));
  mi.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllMenus();
    onClick();
  });
  return mi;
}

// Live filter text of the composer model dropdown. Kept module-level so a
// `renderSelectors()` re-read (config/models reload) preserves the query and
// the input is rebuilt with it; cleared once a model is actually picked.
let modelFilter = "";

export function renderSelectors(): void {
  const cfg: Dict = settings.config || {};
  const provider: Dict = cfg.provider || {};

  setSelButton(document.getElementById("selModelBtn"), t("web.selectors.model"), cfg.model || "—");
  const modelMenu = document.getElementById("selModelMenu") as HTMLElement;
  modelMenu.textContent = "";
  // Search row stays outside the filtered list: `drawModelList` only touches
  // `listBox`, so typing never rebuilds (or unfocuses) the input itself.
  const search = document.createElement("input");
  search.id = "selModelSearch";
  search.className = "searchbox";
  search.type = "search";
  search.autocomplete = "off";
  search.spellcheck = false;
  search.placeholder = t("web.selectors.search_models");
  search.setAttribute("aria-label", t("web.selectors.search_models"));
  search.value = modelFilter;
  search.addEventListener("click", (e) => e.stopPropagation());
  modelMenu.appendChild(search);
  const listBox = el("div", "model-menu-list");
  modelMenu.appendChild(listBox);
  const drawModelList = () => {
    listBox.textContent = "";
    const models = settings.models.filter((m) => matchesQuery(m, modelFilter));
    if (!models.length) {
      listBox.appendChild(el("div", "mi dim", settings.models.length ? t("web.settings.no_matches") : t("web.selectors.no_models")));
      return;
    }
    models.forEach((m) => {
      const item = menuItem(String(m), "", m === cfg.model, () => {
        modelFilter = "";
        void postConfig("model", m, true);
      });
      // ArrowUp on the first row returns focus to the search field.
      item.addEventListener("keydown", (e) => {
        if (e.key === "ArrowUp" && item === listBox.querySelector(".mi:not(.dim)")) {
          e.preventDefault();
          e.stopPropagation();
          search.focus();
        }
      });
      listBox.appendChild(item);
    });
  };
  search.addEventListener("input", () => {
    modelFilter = search.value;
    drawModelList();
  });
  search.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const first = listBox.querySelector<HTMLElement>(".mi:not(.dim)");
      if (first) first.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const first = listBox.querySelector<HTMLElement>(".mi:not(.dim)");
      if (first) first.click();
    } else if (e.key === "Escape") {
      if (search.value) {
        e.preventDefault();
        search.value = "";
        modelFilter = "";
        drawModelList();
      } else {
        closeAllMenus();
      }
    }
  });
  drawModelList();
  modelMenu.appendChild(el("div", "sep"));
  modelMenu.appendChild(
    menuAction(t("web.selectors.refresh_list"), "refresh", () => {
      void loadModels().then(renderSelectors);
    }),
  );

  setSelButton(document.getElementById("selProviderBtn"), t("web.selectors.provider"), provider.active || provider.type || "—");
  const provMenu = document.getElementById("selProviderMenu") as HTMLElement;
  provMenu.textContent = "";
  const entries = Array.isArray(provider.entries) && provider.entries.length
    ? provider.entries
    : [{ label: provider.active || provider.type, type: provider.type }];
  entries.forEach((entry: Dict) => {
    const name = entry.label || entry.type;
    if (!name) return;
    provMenu.appendChild(menuItem(name, entry.type || "", name === (provider.active || provider.type), () => void postConfig("provider.active", name, true)));
  });

  // auto — первый пункт: окно берётся у провайдера для активной модели
  // (`POST /api/config {contextAuto:true}` пробует бэкенд сразу). Пока auto
  // включён, фиксированные размеры не помечаются «current» — иначе в меню
  // горели бы два активных пункта. Boot (config === null): режим ещё не
  // известен — кнопка честно показывает «—», пункт auto неактивен.
  const auto = !!settings.config && cfg.contextAuto !== false;
  setSelButton(
    document.getElementById("selContextBtn"),
    t("web.selectors.context"),
    auto ? t("web.selectors.auto") : contextLabel(),
  );
  const ctxMenu = document.getElementById("selContextMenu") as HTMLElement;
  ctxMenu.textContent = "";
  // Sub-строка auto — разрешённое окно: кнопка показывает только «auto»,
  // число живёт здесь и в сайдбаре.
  ctxMenu.appendChild(
    menuItem(t("web.selectors.auto"), auto ? contextLabel() : "", auto, () =>
      void postConfig("contextAuto", true, false),
    ),
  );
  ctxMenu.appendChild(el("div", "sep"));
  const sizes = [8192, 16384, 32768, 65536, 131072];
  sizes.forEach((n) => {
    const active = !auto && n === cfg.contextWindow;
    ctxMenu.appendChild(menuItem(Math.round(n / 1024) + "K", active ? t("web.selectors.current") : "", active, () => void postConfig("contextWindow", n, false)));
  });
  ctxMenu.appendChild(el("div", "sep"));
  // Inline custom size (no native `window.prompt`): the menu stays open while
  // typing; Enter/save commits and closes it.
  const custom = el("button", "mi row-mi");
  custom.type = "button";
  custom.appendChild(icon("settings"));
  custom.appendChild(el("span", "", t("web.selectors.custom")));
  custom.addEventListener("click", (e) => {
    e.stopPropagation();
    if (ctxMenu.querySelector(".ctx-custom")) return;
    const wrap = el("div", "ctx-custom");
    const input = el("input");
    input.type = "number";
    input.min = "1024";
    input.step = "1024";
    input.value = String(cfg.contextWindow || 32768);
    input.placeholder = t("web.selectors.context_prompt");
    input.setAttribute("aria-label", t("web.selectors.context_prompt"));
    const commit = () => {
      const n = Number(input.value.trim());
      if (Number.isFinite(n) && n >= 1024) {
        closeAllMenus();
        void postConfig("contextWindow", n, false);
      } else {
        input.focus();
      }
    };
    input.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        ev.preventDefault();
        commit();
      } else if (ev.key === "Escape") {
        wrap.remove();
      }
    });
    const ok = link(t("web.settings.save"), "", commit);
    wrap.appendChild(input);
    wrap.appendChild(ok);
    ctxMenu.appendChild(wrap);
    setTimeout(() => input.focus(), 0);
  });
  ctxMenu.appendChild(custom);

  renderReasoningSelector();

  // Keep the pending paint in sync: boot (config === null) and an in-flight
  // switch both show the mark; a mid-switch re-read must not clear it.
  paintSelectorPending();
}

// 4th selector row: reasoning effort filtered to what the active
// provider+model actually supports (`GET /api/models` → `reasoning`).
// Unknown (boot) or `strategy: "none"` → hidden, never a wrong option list.
// Probe not confirmed → the row stays with an honest note and the full level
// list, because fixed levels may still work (INV-R7).
function renderReasoningSelector(): void {
  const wrap = document.querySelector<HTMLElement>('[data-sel="reasoning"]');
  const btn = document.getElementById("selReasoningBtn");
  const menu = document.getElementById("selReasoningMenu");
  if (!wrap || !btn || !menu) return;
  const info: Dict = session.reasoning;
  if (!info || info.strategy === "none") {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const mode = (settings.config && getPath(settings.config, "reasoning.mode")) || info.mode || "auto";
  setSelButton(btn, t("web.selectors.reasoning"), String(mode));
  menu.textContent = "";
  const status = reasoningStatus(info);
  if (status.noteKey) {
    menu.appendChild(el("div", "mi dim", t(status.noteKey)));
    menu.appendChild(el("div", "sep"));
  }
  status.levels.forEach((lvl) => {
    menu.appendChild(menuItem(lvl, lvl === mode ? t("web.selectors.current") : "", lvl === mode, () => void postConfig("reasoning.mode", lvl, false)));
  });
  menu.appendChild(el("div", "sep"));
  menu.appendChild(
    menuAction(t("web.settings.reasoning"), "settings", () => openSettingsPanel("reasoning")),
  );
}

document.querySelectorAll<HTMLElement>("[data-sel]").forEach((sel) => {
  const btn = sel.querySelector("button");
  if (!btn) return;
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    setSessOpen(false);
    document.querySelectorAll<HTMLElement>("[data-sel]").forEach((s) => {
      if (s !== sel) {
        s.classList.remove("open");
        const b = s.querySelector("button");
        if (b) b.setAttribute("aria-expanded", "false");
      }
    });
    const open = sel.classList.toggle("open");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    // Opening the model menu lands focus in its search field.
    if (open && sel.dataset && sel.dataset.sel === "model") {
      const search = document.getElementById("selModelSearch");
      if (search) setTimeout(() => search.focus(), 0);
    }
  });
});

setSelectorRenderer(renderSelectors);
// A5: счётчик ожидания переключателя — следит за классом `pending` сам.
initPendingWait();
