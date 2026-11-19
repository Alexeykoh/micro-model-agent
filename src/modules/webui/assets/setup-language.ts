/** Компактный переключатель языка на первом слайде. */
import { api } from "./setup-api.js";
import type { SetupContext } from "./setup-context.js";
import { h } from "./setup-dom.js";
import { applyDicts, tr } from "./setup-i18n.js";
import type { Dict } from "./setup-state.js";

const FALLBACK = [
  { value: "en", label: "English" },
  { value: "ru", label: "Русский" },
];

/** Сегмент «English · Русский»: меняет локаль сразу, без смены шага. */
export function renderLanguageSwitch(ctx: SetupContext): HTMLElement {
  const box = h("div", "setup-lang");
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", tr("web.setup.language.label"));
  box.appendChild(h("span", "setup-lang-label", tr("web.setup.language.label")));
  const langs: Dict[] = ctx.state.display?.languages?.length
    ? ctx.state.display.languages
    : FALLBACK;
  langs.forEach((l: Dict) => {
    const on = ctx.state.answers.locale === l.value;
    const btn = h("button", "setup-lang-opt" + (on ? " on" : ""), l.label);
    btn.type = "button";
    btn.setAttribute("aria-pressed", String(on));
    btn.addEventListener("click", async () => {
      if (ctx.state.answers.locale === l.value) return;
      ctx.state.answers.locale = l.value;
      const r = await api<{ dicts?: Record<string, Record<string, string>> }>("/api/setup/locale", {
        method: "POST",
        body: { locale: l.value },
      });
      if (r.ok && r.data && r.data.dicts) applyDicts(r.data.dicts, l.value);
      ctx.render();
    });
    box.appendChild(btn);
  });
  return box;
}
