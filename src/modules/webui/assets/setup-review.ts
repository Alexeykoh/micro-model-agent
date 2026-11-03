/** Шаг Review: сводка ответов перед сохранением. */
import type { SetupContext } from "./setup-context.js";
import { h, messageEl, stepBody } from "./setup-dom.js";
import { tr } from "./setup-i18n.js";

function securitySummary(ctx: SetupContext): string {
  const on: string[] = [];
  if (ctx.state.answers.securityPathsRestrict) on.push(tr("web.setup.security.paths"));
  if (ctx.state.answers.securityBashBlock) on.push(tr("web.setup.security.bash"));
  if (ctx.state.answers.securityFlagsBlock) on.push(tr("web.setup.security.flags"));
  return on.length ? on.join(", ") : tr("web.setup.review.security_off");
}

function maskedKey(ctx: SetupContext): string {
  const k = ctx.state.answers.apiKey;
  if (!k) return tr("web.setup.review.not_needed");
  return k.length <= 4 ? "••••" : "••••" + k.slice(-4);
}

export function renderReview(ctx: SetupContext): HTMLElement {
  const box = stepBody("review");
  const rows: Array<[string, string]> = [
    [tr("web.setup.review.provider"), ctx.state.answers.provider],
    [tr("web.setup.review.baseUrl"), ctx.state.answers.apiBase],
    [tr("web.setup.review.apiKey"), maskedKey(ctx)],
    [tr("web.setup.review.model"), ctx.state.answers.model],
    [tr("web.setup.review.context"), String(ctx.state.answers.contextWindow)],
    [tr("web.setup.review.iterations"), String(ctx.state.answers.maxToolIterations)],
    [tr("web.setup.review.locale"), ctx.state.answers.locale],
    [tr("web.setup.review.security"), securitySummary(ctx)],
  ];
  const summary = h("div", "setup-summary");
  rows.forEach(([k, v]) => {
    const r = h("div", "r");
    r.appendChild(h("span", "k", k));
    r.appendChild(h("span", "v", v));
    summary.appendChild(r);
  });
  box.appendChild(summary);
  box.appendChild(messageEl());
  return box;
}
