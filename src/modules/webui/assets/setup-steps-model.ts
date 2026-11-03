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
    const r = await api<{ ok?: boolean }>("/api/setup/test", {
      method: "POST",
      body: {
        baseUrl: ctx.state.answers.apiBase,
        apiKey: ctx.state.answers.apiKey,
        model: ctx.state.answers.model,
      },
    });
    test.disabled = false;
    if (r.ok && r.data && r.data.ok) setMsg(box, "ok", tr("web.setup.model.test_ok"));
    else setMsg(box, "warn", tr("web.setup.model.test_fail"));
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
  const cw = h("input", "setup-input");
  cw.type = "number";
  cw.min = "1024";
  cw.step = "1024";
  cw.value = String(ctx.state.answers.contextWindow);
  cw.addEventListener("input", () => {
    ctx.state.answers.contextWindow = parseInt(cw.value, 10) || 0;
  });
  box.appendChild(field(tr("web.setup.context.contextWindow"), cw));

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
  const row = h("div", "setup-row-inline");
  row.appendChild(detect);
  box.appendChild(row);

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
