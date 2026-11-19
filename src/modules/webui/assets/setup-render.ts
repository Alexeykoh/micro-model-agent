/** Каркас визарда: заголовок, полоса групп, тело текущего шага и кнопки. */
import { renderActions } from "./setup-actions.js";
import type { SetupContext } from "./setup-context.js";
import { h } from "./setup-dom.js";
import { tr } from "./setup-i18n.js";
import { renderReview } from "./setup-review.js";
import { closePopup, renderSecurity } from "./setup-security.js";
import { STEP_GROUPS, STEPS, groupOfStep, stepInGroup } from "./setup-state.js";
import { renderContext, renderModel } from "./setup-steps-model.js";
import { renderKey, renderProvider, renderProviderChoice } from "./setup-steps-provider.js";
import { renderAgentIntro, renderCritic, renderWebSearch } from "./setup-steps-agent.js";
import { renderAppearance } from "./setup-steps-appearance.js";
import { renderWelcome } from "./setup-intro.js";

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
  // Фокус переносим только при смене шага: смена языка и выбор опции не должны
  // выдёргивать пользователя из кнопки наверх страницы.
  if (ctx.state.step !== focusedStep) {
    focusedStep = ctx.state.step;
    focusStep(wrap);
  }
}

let focusedStep = -1;

function renderSteps(ctx: SetupContext): HTMLElement {
  const box = h("div", "setup-steps");
  const current = groupOfStep(ctx.state.step);
  const currentIdx = STEP_GROUPS.findIndex((g) => g.id === current);
  STEP_GROUPS.forEach((group, i) => {
    if (i) box.appendChild(h("span", "sep", "·"));
    const done = i < currentIdx;
    const cls = group.id === current ? "s on" : done ? "s done" : "s";
    const span = h("span", cls, (done ? "✓ " : "") + tr(group.label));
    if (group.id === current) span.setAttribute("aria-current", "step");
    box.appendChild(span);
  });

  const inGroup = stepInGroup(ctx.state.step);
  if (inGroup.total > 1) {
    box.appendChild(
      h(
        "span",
        "setup-progress",
        tr("web.setup.progress", { index: inGroup.index, total: inGroup.total }),
      ),
    );
  }
  return box;
}

function renderBody(ctx: SetupContext): HTMLElement {
  const name = STEPS[ctx.state.step];
  if (name === "welcome") return renderWelcome(ctx);
  if (name === "provider-choice") return renderProviderChoice(ctx);
  if (name === "provider") return renderProvider(ctx);
  if (name === "key") return renderKey(ctx);
  if (name === "model") return renderModel(ctx);
  if (name === "context") return renderContext(ctx);
  if (name === "agent") return renderAgentIntro(ctx);
  if (name === "critic") return renderCritic(ctx);
  if (name === "websearch") return renderWebSearch(ctx);
  if (name === "appearance") return renderAppearance(ctx);
  if (name === "security") return renderSecurity(ctx);
  return renderReview(ctx);
}

/** Фокус на заголовок шага: клавиатура и скринридер не остаются в кнопке. */
function focusStep(wrap: HTMLElement): void {
  const target = wrap.querySelector<HTMLElement>(".setup-step-title, .setup-welcome-lead");
  if (!target) return;
  target.tabIndex = -1;
  target.focus({ preventScroll: true });
}
