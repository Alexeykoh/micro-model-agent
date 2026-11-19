/** Шаги Model / Context: выбор модели, лимиты и авто-определение окна. */
import { api } from "./setup-api.js";
import type { SetupContext } from "./setup-context.js";
import { field, h, inputEl, messageEl, setMsg, stepBody } from "./setup-dom.js";
import { pluralCount, tr } from "./setup-i18n.js";

export function renderModel(ctx: SetupContext): HTMLElement {
  const box = stepBody("model");
  const input = inputEl(ctx.state.answers.model, "text", "qwen/qwen3.5-9b");
  input.addEventListener("input", () => {
    ctx.state.answers.model = input.value.trim();
  });
  box.appendChild(field(tr("web.setup.model.name"), input));

  const results = h("div");
  const row = h("div", "setup-row-inline");
  const load = h("button", "setup-btn", tr("web.setup.model.load"));
  load.type = "button";
  const test = h("button", "setup-btn", tr("web.setup.model.test"));
  test.type = "button";

  load.addEventListener("click", async () => {
    load.disabled = true;
    setMsg(box, "", "");
    const r = await api<{ models?: string[] }>("/api/setup/models", {
      method: "POST",
      body: { baseUrl: ctx.state.answers.apiBase, apiKey: ctx.state.answers.apiKey },
    });
    load.disabled = false;
    const models = (r.ok && r.data && r.data.models) || [];
    if (!models.length) {
      setMsg(box, "warn", tr("web.setup.model.load_none"));
      return;
    }
    setMsg(box, "ok", pluralCount("web.setup.model.load_found", models.length));
    results.replaceChildren();
    models.slice(0, 20).forEach((m) => {
      const b = h("button", "setup-opt" + (ctx.state.answers.model === m ? " on" : ""));
      b.type = "button";
      b.appendChild(h("span", "g", ctx.state.answers.model === m ? "✓" : "◇"));
      b.appendChild(h("span", "t", m));
      b.addEventListener("click", () => {
        ctx.state.answers.model = m;
        input.value = m;
        ctx.render();
      });
      results.appendChild(b);
    });
  });

  test.addEventListener("click", async () => {
    if (!ctx.state.answers.model) {
      setMsg(box, "err", tr("web.setup.model.required"));
      return;
    }
    test.disabled = true;
    setMsg(box, "", tr("web.setup.model.testing"));
    const r = await api<{ ok?: boolean; error?: string }>("/api/setup/test", {
      method: "POST",
      body: {
        baseUrl: ctx.state.answers.apiBase,
        apiKey: ctx.state.answers.apiKey,
        model: ctx.state.answers.model,
        providerType: ctx.state.answers.provider,
      },
    });
    test.disabled = false;
    if (r.ok && r.data && r.data.ok) setMsg(box, "ok", tr("web.setup.model.test_ok"));
    else {
      const detail = r.ok && r.data && r.data.error;
      setMsg(
        box,
        "warn",
        detail
          ? tr("web.setup.model.test_fail_detail", { error: detail })
          : tr("web.setup.model.test_fail"),
      );
    }
  });

  row.appendChild(load);
  row.appendChild(test);
  box.appendChild(row);
  box.appendChild(results);
  box.appendChild(messageEl());
  return box;
}

export function renderContext(ctx: SetupContext): HTMLElement {
  const box = stepBody("context");
  box.appendChild(modeSwitch(ctx));
  if (ctx.state.answers.contextAuto) autoContext(ctx, box);
  else manualContext(ctx, box);

  const it = h("input", "setup-input");
  it.type = "number";
  it.min = "1";
  it.value = String(ctx.state.answers.maxToolIterations);
  it.addEventListener("input", () => {
    ctx.state.answers.maxToolIterations = parseInt(it.value, 10) || 0;
  });
  box.appendChild(field(tr("web.setup.context.maxToolIterations"), it));
  box.appendChild(messageEl());
  return box;
}

/** Переключатель «Авто / Вручную». */
function modeSwitch(ctx: SetupContext): HTMLElement {
  const row = h("div", "setup-seg");
  for (const auto of [true, false]) {
    const on = ctx.state.answers.contextAuto === auto;
    const btn = h(
      "button",
      "setup-seg-opt" + (on ? " on" : ""),
      tr(auto ? "web.setup.context.mode_auto" : "web.setup.context.mode_manual"),
    );
    btn.type = "button";
    btn.setAttribute("aria-pressed", String(on));
    btn.addEventListener("click", () => {
      if (ctx.state.answers.contextAuto === auto) return;
      ctx.state.answers.contextAuto = auto;
      if (auto) ctx.state.contextProbe = { status: "idle" };
      ctx.render();
    });
    row.appendChild(btn);
  }
  return row;
}

function probeKey(ctx: SetupContext): string {
  return `${ctx.state.answers.apiBase}|${ctx.state.answers.model}`;
}

/** Авто: окно определяется провайдером, значение показывается read-only. */
function autoContext(ctx: SetupContext, box: HTMLElement): void {
  const key = probeKey(ctx);
  const probe = ctx.state.contextProbe;
  if (probe.key && probe.key !== key && probe.status !== "running") {
    ctx.state.contextProbe = { status: "idle" };
  }

  const status = h("div", "setup-auto-status");
  box.appendChild(status);
  if (ctx.state.contextProbe.status === "running" || ctx.state.contextProbe.status === "idle") {
    setMsg(box, "", tr("web.setup.context.detecting"));
  } else if (ctx.state.contextProbe.status === "ok") {
    status.appendChild(
      h(
        "span",
        "setup-auto-value",
        tr("web.setup.context.auto_value", { count: ctx.state.contextProbe.value || 0 }),
      ),
    );
  } else if (ctx.state.contextProbe.status === "fail") {
    setMsg(box, "warn", tr("web.setup.context.detect_fail"));
  }

  const row = h("div", "setup-row-inline");
  const again = h(
    "button",
    "setup-btn",
    tr(
      ctx.state.contextProbe.status === "ok"
        ? "web.setup.context.detect_again"
        : "web.setup.context.detect",
    ),
  );
  again.type = "button";
  again.addEventListener("click", () => {
    ctx.state.contextProbe = { status: "idle" };
    ctx.render();
  });
  row.appendChild(again);
  box.appendChild(row);

  if (ctx.state.contextProbe.status === "idle") {
    if (!ctx.state.answers.apiBase || !ctx.state.answers.model) {
      ctx.state.contextProbe = { status: "fail" };
    } else {
      ctx.state.contextProbe = { status: "running", key };
      void Promise.resolve().then(() => runProbe(ctx, key));
    }
  }
}

function runProbe(ctx: SetupContext, key: string): void {
  void api<{ ok?: boolean; contextWindow?: number }>("/api/setup/context", {
    method: "POST",
    body: {
      baseUrl: ctx.state.answers.apiBase,
      apiKey: ctx.state.answers.apiKey,
      model: ctx.state.answers.model,
      providerType: ctx.state.answers.provider,
    },
  }).then((r) => {
    const n = r.ok && r.data && r.data.contextWindow;
    if (r.ok && r.data && r.data.ok && typeof n === "number" && n > 0) {
      ctx.state.answers.contextWindow = n;
      ctx.state.contextProbe = { status: "ok", value: n, key };
    } else {
      ctx.state.answers.contextAuto = false;
      ctx.state.contextProbe = { status: "fail", key };
    }
    ctx.render();
  });
}

/** Ручной режим: число вводится вручную. */
function manualContext(ctx: SetupContext, box: HTMLElement): void {
  const cw = h("input", "setup-input");
  cw.type = "number";
  cw.min = "1024";
  cw.step = "1024";
  cw.value = String(ctx.state.answers.contextWindow);
  cw.addEventListener("input", () => {
    ctx.state.answers.contextWindow = parseInt(cw.value, 10) || 0;
  });
  box.appendChild(field(tr("web.setup.context.contextWindow"), cw));

  const row = h("div", "setup-row-inline");
  const detect = h("button", "setup-btn", tr("web.setup.context.detect"));
  detect.type = "button";
  detect.addEventListener("click", async () => {
    if (!ctx.state.answers.apiBase || !ctx.state.answers.model) {
      setMsg(box, "err", tr("web.setup.context.detect_fail"));
      return;
    }
    detect.disabled = true;
    setMsg(box, "", tr("web.setup.context.detecting"));
    const r = await api<{ ok?: boolean; contextWindow?: number }>("/api/setup/context", {
      method: "POST",
      body: {
        baseUrl: ctx.state.answers.apiBase,
        apiKey: ctx.state.answers.apiKey,
        model: ctx.state.answers.model,
        providerType: ctx.state.answers.provider,
      },
    });
    detect.disabled = false;
    const n = r.ok && r.data && r.data.contextWindow;
    if (r.ok && r.data && r.data.ok && typeof n === "number" && n > 0) {
      ctx.state.answers.contextWindow = n;
      cw.value = String(n);
      setMsg(box, "ok", tr("web.setup.context.detect_ok", { count: n }));
    } else {
      setMsg(box, "warn", tr("web.setup.context.detect_fail"));
    }
  });
  row.appendChild(detect);
  box.appendChild(row);
}
