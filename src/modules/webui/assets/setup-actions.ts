/** Кнопки шага: назад/далее, валидация и сохранение ответов. */
import { api } from "./setup-api.js";
import type { SetupContext } from "./setup-context.js";
import { clearMsg, h, setMsg } from "./setup-dom.js";
import { tr } from "./setup-i18n.js";
import { STEPS, stepIndex } from "./setup-state.js";
import { clearDraft, saveDraft } from "./setup-draft.js";

export function validate(ctx: SetupContext): string | null {
  const name = STEPS[ctx.state.step];
  if (name === "provider" && ctx.state.answers.configureProvider) {
    if (!ctx.state.answers.apiBase) return tr("web.setup.provider.required");
  }
  if (name === "model" && ctx.state.answers.configureProvider) {
    if (!ctx.state.answers.model) return tr("web.setup.model.required");
  }
  if (name === "context") {
    if (!(ctx.state.answers.maxToolIterations > 0)) return tr("web.setup.context.required");
    if (!(ctx.state.answers.contextWindow > 0)) return tr("web.setup.context.required");
  }
  return null;
}

/** Следующий шаг с учётом «Пропустить» на 2.0. */
function nextStep(ctx: SetupContext): number {
  const name = STEPS[ctx.state.step];
  if (name === "provider-choice" && !ctx.state.answers.configureProvider) {
    return stepIndex("agent");
  }
  return Math.min(STEPS.length - 1, ctx.state.step + 1);
}

/** Предыдущий шаг: после «Пропустить» возвращаемся сразу в 2.0. */
function prevStep(ctx: SetupContext): number {
  const name = STEPS[ctx.state.step];
  if (name === "agent" && !ctx.state.answers.configureProvider) {
    return stepIndex("provider-choice");
  }
  return Math.max(0, ctx.state.step - 1);
}

export function renderActions(ctx: SetupContext): HTMLElement {
  const box = h("div", "setup-actions");
  const first = ctx.state.step === 0;
  const back = h("button", "setup-btn", tr("web.setup.back"));
  back.type = "button";
  back.disabled = first;
  back.addEventListener("click", () => {
    if (first) return;
    clearMsg();
    ctx.state.step = prevStep(ctx);
    saveDraft(ctx.state);
    ctx.render();
  });
  box.appendChild(back);
  box.appendChild(h("span", "spacer"));

  if (ctx.state.step < STEPS.length - 1) {
    const next = h("button", "setup-btn primary", tr(first ? "web.setup.start" : "web.setup.next"));
    next.type = "button";
    next.addEventListener("click", () => {
      const err = validate(ctx);
      if (err) {
        setMsg(ctx.gate.querySelector(".setup-step"), "err", err);
        return;
      }
      clearMsg();
      ctx.state.step = nextStep(ctx);
      saveDraft(ctx.state);
      ctx.render();
    });
    box.appendChild(next);
  } else {
    const finish = h("button", "setup-btn primary", tr("web.setup.finish"));
    finish.type = "button";
    finish.addEventListener("click", () => void finishSetup(ctx, finish));
    box.appendChild(finish);
  }
  return box;
}

async function finishSetup(ctx: SetupContext, btn: HTMLButtonElement): Promise<void> {
  const err = validate(ctx);
  if (err) {
    setMsg(ctx.gate.querySelector(".setup-step"), "err", err);
    return;
  }
  btn.disabled = true;
  setMsg(ctx.gate.querySelector(".setup-step"), "", tr("web.setup.saving"));
  const r = await api<{ warning?: string }>("/api/setup", {
    method: "POST",
    body: {
      provider: ctx.state.answers.provider,
      apiBase: ctx.state.answers.apiBase,
      apiKey: ctx.state.answers.apiKey,
      model: ctx.state.answers.model,
      contextWindow: ctx.state.answers.contextWindow,
      maxToolIterations: ctx.state.answers.maxToolIterations,
      locale: ctx.state.answers.locale,
      securityBashBlock: ctx.state.answers.securityBashBlock,
      securityFlagsBlock: ctx.state.answers.securityFlagsBlock,
      securityPathsRestrict: ctx.state.answers.securityPathsRestrict,
      soundsEnabled: ctx.state.answers.sounds.enabled,
      sounds: ctx.state.answers.sounds,
      securityDetail: ctx.state.answers.securityDetail,
      configureProvider: ctx.state.answers.configureProvider,
      contextAuto: ctx.state.answers.contextAuto,
      criticEnabled: ctx.state.answers.criticEnabled,
      webSearchEnabled: ctx.state.answers.webSearchEnabled,
      theme: ctx.state.answers.theme,
      themeMode: ctx.state.answers.themeMode,
      themeEffects: ctx.state.answers.themeEffects,
    },
  });
  if (!r.ok) {
    btn.disabled = false;
    setMsg(ctx.gate.querySelector(".setup-step"), "err", tr("web.setup.failed"));
    return;
  }
  clearDraft();
  if (r.data && r.data.warning) {
    setMsg(
      ctx.gate.querySelector(".setup-step"),
      "warn",
      tr("web.setup.saved_warning", { warning: r.data.warning }),
    );
    setTimeout(() => location.reload(), 1500);
    return;
  }
  location.reload();
}
