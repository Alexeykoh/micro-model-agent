/** Слайд знакомства: язык сверху, короткий текст про агента, без чек-листа. */
import type { SetupContext } from "./setup-context.js";
import { h } from "./setup-dom.js";
import { tr } from "./setup-i18n.js";
import { renderLanguageSwitch } from "./setup-language.js";

export function renderWelcome(ctx: SetupContext): HTMLElement {
  const box = h("div", "setup-step setup-welcome");
  box.appendChild(renderLanguageSwitch(ctx));
  box.appendChild(h("p", "setup-welcome-lead", tr("web.setup.welcome.lead")));
  box.appendChild(h("p", "setup-welcome-line", tr("web.setup.welcome.model")));
  box.appendChild(h("p", "setup-welcome-line", tr("web.setup.welcome.controls")));
  box.appendChild(h("p", "setup-welcome-foot", tr("web.setup.welcome.footnote")));
  return box;
}
