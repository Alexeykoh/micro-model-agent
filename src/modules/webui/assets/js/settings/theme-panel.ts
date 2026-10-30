// Карточка «UI & Theme»: режим оформления + пикер скинов. Вынесена из
// `panels.ts` (файл держится у потолка размера), запись идёт в конфиг через
// `postConfig`, а не только в localStorage: см.
// docs/specs/2026-10-30-webui-theme-persistence-design.md.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { buildThemePicker } from "./theme-picker.js";
import { postConfig } from "./write.js";
import { applyTheme, applyUiTheme, currentTheme, currentUiTheme } from "./theme.js";
import { THEME_MODES } from "./theme-state.js";

/** Фабрика строки настройки (`row` из `panels.ts`), чтобы не тянуть его сюда. */
export type RowFactory = (
  label: string,
  control: string | Node | null,
  desc?: string,
) => HTMLElement;

/**
 * Применяет выбор сразу (пикер обязан откликаться без ожидания сети), пишет
 * его в конфиг и откатывается к прежнему значению, если запись не прошла.
 */
async function pick(
  key: string,
  value: string,
  apply: (v: string) => void,
  before: string,
  rerender: () => void,
): Promise<void> {
  apply(value);
  rerender();
  const ok = await postConfig(key, value, false);
  // Повторное применение закрывает гонку с `loadConfig` (SSE `config`), который
  // мог сбросить локальный оверрайд, пока запись была в полёте.
  apply(ok ? value : before);
  rerender();
}

/**
 * Собирает карточку темы. `rerender` перерисовывает панель UI, `row` — общая
 * фабрика строк (панель владеет разметкой, карточка — поведением).
 */
export function buildThemeCard(rerender: () => void, row: RowFactory): HTMLElement {
  const card = el("div", "settings-section");
  const head = el("div", "sec-head");
  head.appendChild(el("span", "sec-title", t("web.settings.sec.ui.theme")));
  card.appendChild(head);
  const desc = t("web.settings.sec.ui.theme.desc");
  if (desc !== "web.settings.sec.ui.theme.desc") card.appendChild(el("div", "sec-desc", desc));

  const body = el("div", "sec-body");
  const modeSeg = el("span", "seg");
  THEME_MODES.forEach((value) => {
    const active = currentTheme() === value;
    const button = el("button", active ? "on" : "", value);
    button.type = "button";
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.addEventListener("click", () => {
      const before = currentTheme();
      void pick("ui.themeMode", value, applyTheme, before, rerender);
    });
    modeSeg.appendChild(button);
  });
  body.appendChild(row(t("web.settings.mode"), modeSeg));
  body.appendChild(
    row(
      t("web.settings.theme"),
      buildThemePicker(currentUiTheme(), (id) => {
        const before = currentUiTheme();
        void pick("ui.theme", id, applyUiTheme, before, rerender);
      }),
    ),
  );
  card.appendChild(body);
  return card;
}
