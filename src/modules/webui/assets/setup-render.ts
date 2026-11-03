/** Каркас визарда: заголовок, полоса шагов, тело текущего шага и кнопки. */
import { renderActions } from "./setup-actions.js";
import type { SetupContext } from "./setup-context.js";
import { h } from "./setup-dom.js";
import { tr } from "./setup-i18n.js";
import { renderReview } from "./setup-review.js";
import { closePopup, renderSecurity } from "./setup-security.js";
import { STEPS } from "./setup-state.js";
import { renderContext, renderModel } from "./setup-steps-model.js";
import { renderKey, renderLanguage, renderProvider } from "./setup-steps-provider.js";

export function render(ctx: SetupContext): void {
  closePopup();
  const wrap = h("div", "setup-wrap");
  const title = h("h1", "setup-h");
  title.appendChild(h("span", "glyph", "◇"));
  title.appendChild(document.createTextNode(tr("web.setup.title")));
  wrap.appendChild(title);
  wrap.appendChild(h("p", "setup-sub", tr("web.setup.subtitle")));
  wrap.appendChild(renderSteps(ctx));
  wrap.appendChild(renderBody(ctx));
  wrap.appendChild(renderActions(ctx));
  ctx.gate.replaceChildren();
  ctx.gate.appendChild(wrap);
}

function renderSteps(ctx: SetupContext): HTMLElement {
  const box = h("div", "setup-steps");
  STEPS.forEach((name, i) => {
    if (i) box.appendChild(h("span", "sep", "·"));
    const cls = i === ctx.state.step ? "s on" : i < ctx.state.step ? "s done" : "s";
    box.appendChild(
      h("span", cls, (i < ctx.state.step ? "✓ " : "") + tr("web.setup.step." + name)),
    );
  });
  return box;
}

function renderBody(ctx: SetupContext): HTMLElement {
  const name = STEPS[ctx.state.step];
  if (name === "language") return renderLanguage(ctx);
  if (name === "provider") return renderProvider(ctx);
  if (name === "key") return renderKey(ctx);
  if (name === "model") return renderModel(ctx);
  if (name === "context") return renderContext(ctx);
  if (name === "security") return renderSecurity(ctx);
  return renderReview(ctx);
}
