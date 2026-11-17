/** Шаг 4.0: сводка ответов, проверка запуском и финальное сохранение. */
import { api } from "./setup-api.js";
import type { SetupContext } from "./setup-context.js";
import { h, messageEl, setMsg, stepBody } from "./setup-dom.js";
import { tr } from "./setup-i18n.js";

function securitySummary(ctx: SetupContext): string {
  const on: string[] = [];
  if (ctx.state.answers.securityPathsRestrict) on.push(tr("web.setup.security.paths"));
  if (ctx.state.answers.securityBashBlock) on.push(tr("web.setup.security.bash"));
  if (ctx.state.answers.securityFlagsBlock) on.push(tr("web.setup.security.flags"));
  return on.length ? on.join(", ") : tr("web.setup.review.security_off");
}

function maskedKey(ctx: SetupContext): string {
  if (!ctx.state.answers.configureProvider) return tr("web.setup.review.unchanged");
  const k = ctx.state.answers.apiKey;
  if (!k) return tr("web.setup.review.not_needed");
  return k.length <= 4 ? "••••" : "••••" + k.slice(-4);
}

function contextSummary(ctx: SetupContext): string {
  if (!ctx.state.answers.configureProvider) return tr("web.setup.review.unchanged");
  const n = String(ctx.state.answers.contextWindow);
  return ctx.state.answers.contextAuto
    ? `${n} · ${tr("web.setup.context.mode_auto")}`
    : `${n} · ${tr("web.setup.context.mode_manual")}`;
}

function providerSummary(ctx: SetupContext): string {
  if (!ctx.state.answers.configureProvider) return tr("web.setup.review.unchanged");
  return ctx.state.answers.provider;
}

function soundSummary(ctx: SetupContext): string {
  const s = ctx.state.answers.sounds;
  if (!s.enabled) return tr("web.setup.review.off");
  return tr("web.setup.review.sounds_on", { volume: s.volume });
}

function themeSummary(ctx: SetupContext): string {
  const theme = tr("web.settings.theme." + ctx.state.answers.theme);
  const mode = tr("web.setup.appearance.mode_" + ctx.state.answers.themeMode);
  return `${theme} · ${mode}`;
}

export function renderReview(ctx: SetupContext): HTMLElement {
  const box = stepBody("review");
  const workspace = ctx.state.display?.workspace;
  if (workspace) {
    box.appendChild(
      h("p", "setup-workspace", tr("web.setup.review.workspace", { path: String(workspace) })),
    );
  }

  const rows: Array<[string, string]> = [
    [tr("web.setup.review.provider"), providerSummary(ctx)],
    [
      tr("web.setup.review.baseUrl"),
      ctx.state.answers.configureProvider
        ? ctx.state.answers.apiBase
        : tr("web.setup.review.unchanged"),
    ],
    [tr("web.setup.review.apiKey"), maskedKey(ctx)],
    [
      tr("web.setup.review.model"),
      ctx.state.answers.configureProvider
        ? ctx.state.answers.model
        : tr("web.setup.review.unchanged"),
    ],
    [tr("web.setup.review.context"), contextSummary(ctx)],
    [tr("web.setup.review.iterations"), String(ctx.state.answers.maxToolIterations)],
    [tr("web.setup.review.locale"), ctx.state.answers.locale],
    [
      tr("web.setup.review.critic"),
      ctx.state.answers.criticEnabled ? tr("web.setup.review.on") : tr("web.setup.review.off"),
    ],
    [
      tr("web.setup.review.websearch"),
      ctx.state.answers.webSearchEnabled ? tr("web.setup.review.on") : tr("web.setup.review.off"),
    ],
    [tr("web.setup.review.theme"), themeSummary(ctx)],
    [tr("web.setup.review.sounds"), soundSummary(ctx)],
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
  box.appendChild(smokeTest(ctx));
  box.appendChild(messageEl());
  return box;
}

/** Реальный короткий запрос: ловит неверную модель/ключ/контекст до старта. */
function smokeTest(ctx: SetupContext): HTMLElement {
  const block = h("div", "setup-smoke");
  const btn = h("button", "setup-btn", tr("web.setup.review.smoke"));
  btn.type = "button";
  btn.addEventListener("click", async () => {
    if (!ctx.state.answers.apiBase || !ctx.state.answers.model) {
      setMsg(ctx.gate.querySelector(".setup-step"), "err", tr("web.setup.review.smoke_skip"));
      return;
    }
    btn.disabled = true;
    setMsg(ctx.gate.querySelector(".setup-step"), "", tr("web.setup.review.smoking"));
    const r = await api<{ ok?: boolean; latencyMs?: number; error?: string }>("/api/setup/test", {
      method: "POST",
      body: {
        baseUrl: ctx.state.answers.apiBase,
        apiKey: ctx.state.answers.apiKey,
        model: ctx.state.answers.model,
        providerType: ctx.state.answers.provider,
      },
    });
    btn.disabled = false;
    if (r.ok && r.data && r.data.ok) {
      setMsg(
        ctx.gate.querySelector(".setup-step"),
        "ok",
        tr("web.setup.review.smoke_ok", { ms: r.data.latencyMs || 0 }),
      );
    } else {
      const detail = r.ok && r.data && r.data.error;
      setMsg(
        ctx.gate.querySelector(".setup-step"),
        "warn",
        detail
          ? tr("web.setup.review.smoke_fail_detail", { error: detail })
          : tr("web.setup.review.smoke_fail"),
      );
    }
  });
  block.appendChild(btn);
  block.appendChild(h("span", "setup-smoke-hint", tr("web.setup.review.smoke_hint")));
  return block;
}
