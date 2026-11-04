/** Шаги Language / Provider / Key: выбор локали, провайдера и ключа. */
import { api } from "./setup-api.js";
import type { SetupContext } from "./setup-context.js";
import { field, h, inputEl, messageEl, setMsg, stepBody } from "./setup-dom.js";
import { applyDicts, pluralCount, tr } from "./setup-i18n.js";
import type { Dict } from "./setup-state.js";

export function renderLanguage(ctx: SetupContext): HTMLElement {
  const box = stepBody("language");
  (ctx.state.display?.languages || []).forEach((l: Dict) => {
    const btn = h("button", "setup-opt" + (ctx.state.answers.locale === l.value ? " on" : ""));
    btn.type = "button";
    btn.appendChild(h("span", "g", ctx.state.answers.locale === l.value ? "✓" : "◇"));
    btn.appendChild(h("span", "t", l.label));
    btn.addEventListener("click", async () => {
      ctx.state.answers.locale = l.value;
      const r = await api<{ dicts?: Record<string, Record<string, string>> }>(
        "/api/setup/locale",
        { method: "POST", body: { locale: l.value } },
      );
      if (r.ok && r.data && r.data.dicts) applyDicts(r.data.dicts, l.value);
      ctx.render();
    });
    box.appendChild(btn);
  });
  return box;
}

export function renderProvider(ctx: SetupContext): HTMLElement {
  const box = stepBody("provider");
  (ctx.state.display?.providers || []).forEach((p: Dict) => {
    const on = ctx.state.answers.provider === p.type;
    const btn = h("button", "setup-opt" + (on ? " on" : ""));
    btn.type = "button";
    btn.appendChild(h("span", "g", on ? "✓" : "◇"));
    btn.appendChild(h("span", "t", p.label));
    btn.addEventListener("click", () => {
      ctx.state.answers.provider = p.type;
      ctx.state.answers.apiBase = p.baseUrl || "";
      ctx.render();
    });
    box.appendChild(btn);
  });

  const input = inputEl(ctx.state.answers.apiBase, "text", "http://localhost:1234/v1");
  input.addEventListener("input", () => {
    ctx.state.answers.apiBase = input.value.trim();
  });
  box.appendChild(field(tr("web.setup.provider.base_url"), input));

  const actions = h("div", "setup-row-inline");
  const test = h("button", "setup-btn", tr("web.setup.provider.test"));
  test.type = "button";
  test.addEventListener("click", async () => {
    if (!ctx.state.answers.apiBase) {
      setMsg(box, "err", tr("web.setup.provider.required"));
      return;
    }
    test.disabled = true;
    setMsg(box, "", tr("web.setup.provider.testing"));
    const r = await api<{ models?: unknown[] }>("/api/setup/models", {
      method: "POST",
      body: { baseUrl: ctx.state.answers.apiBase, apiKey: ctx.state.answers.apiKey },
    });
    test.disabled = false;
    const models = (r.ok && r.data && r.data.models) || [];
    if (r.ok && models.length) setMsg(box, "ok", tr("web.setup.provider.test_ok"));
    else setMsg(box, "warn", tr("web.setup.provider.test_fail"));
  });
  actions.appendChild(test);

  if (
    ctx.state.answers.provider === "openai-compat" ||
    ctx.state.answers.provider === "lmstudio"
  ) {
    const scan = h("button", "setup-btn", tr("web.setup.provider.scan"));
    scan.type = "button";
    const results = h("div");
    scan.addEventListener("click", async () => {
      scan.disabled = true;
      setMsg(box, "", "");
      const r = await api<{ servers?: Dict[] }>("/api/setup/scan", { method: "POST" });
      scan.disabled = false;
      const servers = (r.ok && r.data && r.data.servers) || [];
      if (!r.ok) {
        setMsg(box, "err", tr("web.setup.provider.scan_failed"));
        return;
      }
      if (!servers.length) {
        setMsg(box, "warn", tr("web.setup.provider.scan_none"));
        return;
      }
      setMsg(box, "ok", pluralCount("web.setup.provider.scan_found", servers.length));
      results.replaceChildren();
      servers.forEach((srv: Dict) => {
        const b = h("button", "setup-opt");
        b.type = "button";
        b.appendChild(h("span", "g", "↳"));
        b.appendChild(h("span", "t", srv.label));
        b.appendChild(h("span", "d", srv.url));
        b.addEventListener("click", () => {
          ctx.state.answers.apiBase = srv.url;
          ctx.render();
        });
        results.appendChild(b);
      });
    });
    actions.appendChild(scan);
    box.appendChild(actions);
    box.appendChild(results);
  } else {
    box.appendChild(actions);
  }
  box.appendChild(messageEl());
  return box;
}

export function renderKey(ctx: SetupContext): HTMLElement {
  const box = stepBody("key");
  const input = inputEl(ctx.state.answers.apiKey, "password", tr("web.setup.key.placeholder"));
  input.addEventListener("input", () => {
    ctx.state.answers.apiKey = input.value;
  });
  box.appendChild(field(tr("web.setup.key.label"), input));
  box.appendChild(messageEl());
  return box;
}
