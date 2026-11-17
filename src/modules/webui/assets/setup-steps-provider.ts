/** Шаги 2.0–2.2: выбор «настроить или пропустить», провайдер и ключ. */
import { api } from "./setup-api.js";
import type { SetupContext } from "./setup-context.js";
import { field, h, inputEl, messageEl, setMsg, stepBody } from "./setup-dom.js";
import { pluralCount, tr } from "./setup-i18n.js";
import { stepIndex, type Dict } from "./setup-state.js";

/** 2.0 — спросить, нужна ли настройка провайдера и модели, с автосканом. */
export function renderProviderChoice(ctx: SetupContext): HTMLElement {
  const box = stepBody("provider_choice");
  const current = ctx.state.display?.current || {};
  const summary = h("div", "setup-summary setup-default-box");
  const rows: Array<[string, string]> = [
    [tr("web.setup.provider_choice.current_provider"), String(current.provider || "openai-compat")],
    [
      tr("web.setup.provider_choice.current_url"),
      String(current.apiBase || "http://localhost:1234/v1"),
    ],
    [tr("web.setup.provider_choice.current_model"), String(current.model || "qwen/qwen3.5-9b")],
  ];
  rows.forEach(([k, v]) => {
    const r = h("div", "r");
    r.appendChild(h("span", "k", k));
    r.appendChild(h("span", "v", v));
    summary.appendChild(r);
  });
  box.appendChild(summary);

  const scanLine = h("p", "setup-hint-line setup-scan-line");
  box.appendChild(scanLine);
  const results = h("div");
  box.appendChild(results);
  startScan(ctx, scanLine, results);

  const options = h("div", "setup-opts");
  const configure = h("button", "setup-opt" + (ctx.state.answers.configureProvider ? " on" : ""));
  configure.type = "button";
  configure.appendChild(h("span", "g", ctx.state.answers.configureProvider ? "✓" : "◇"));
  const configureTexts = h("span", "setup-opt-texts");
  configureTexts.appendChild(h("span", "t", tr("web.setup.provider_choice.configure")));
  configureTexts.appendChild(h("span", "d", tr("web.setup.provider_choice.configure_desc")));
  configure.appendChild(configureTexts);
  configure.addEventListener("click", () => {
    ctx.state.answers.configureProvider = true;
    ctx.state.step = stepIndex("provider");
    ctx.render();
  });
  options.appendChild(configure);

  const skip = h("button", "setup-opt" + (!ctx.state.answers.configureProvider ? " on" : ""));
  skip.type = "button";
  skip.appendChild(h("span", "g", !ctx.state.answers.configureProvider ? "✓" : "◇"));
  const skipTexts = h("span", "setup-opt-texts");
  skipTexts.appendChild(h("span", "t", tr("web.setup.provider_choice.skip")));
  skipTexts.appendChild(h("span", "d", tr("web.setup.provider_choice.skip_desc")));
  skip.appendChild(skipTexts);
  skip.addEventListener("click", () => {
    ctx.state.answers.configureProvider = false;
    useCurrentDefaults(ctx);
    ctx.state.step = stepIndex("agent");
    ctx.render();
  });
  options.appendChild(skip);
  box.appendChild(options);
  box.appendChild(messageEl());
  return box;
}

/** На virgin-конфиге текущие значения — это дефолты LM Studio. */
function useCurrentDefaults(ctx: SetupContext): void {
  const current = ctx.state.display?.current || {};
  ctx.state.answers.provider = String(current.provider || "openai-compat");
  ctx.state.answers.apiBase = String(current.apiBase || "http://localhost:1234/v1");
  ctx.state.answers.model = String(current.model || "qwen/qwen3.5-9b");
  if (typeof current.contextWindow === "number") {
    ctx.state.answers.contextWindow = current.contextWindow;
  }
}

/** Автоскан запускается один раз на визард, результат живёт в state. */
function startScan(ctx: SetupContext, line: HTMLElement, results: HTMLElement): void {
  if (ctx.state.scan.done) {
    paintScan(ctx, line, results);
    return;
  }
  ctx.state.scan.done = true;
  line.textContent = tr("web.setup.provider_choice.scanning");
  void api<{ servers?: Array<{ label: string; url: string }> }>("/api/setup/scan", {
    method: "POST",
  }).then((r) => {
    const servers = (r.ok && r.data && r.data.servers) || [];
    ctx.state.scan.servers = servers;
    ctx.render();
  });
}

function paintScan(ctx: SetupContext, line: HTMLElement, results: HTMLElement): void {
  const servers = ctx.state.scan.servers;
  if (!servers.length) {
    line.textContent = tr("web.setup.provider_choice.scan_none");
    return;
  }
  line.textContent = pluralCount("web.setup.provider_choice.scan_found", servers.length);
  servers.forEach((srv) => {
    const b = h("button", "setup-opt");
    b.type = "button";
    b.appendChild(h("span", "g", "↳"));
    b.appendChild(h("span", "t", srv.label));
    b.appendChild(h("span", "d", srv.url));
    b.addEventListener("click", () => {
      ctx.state.answers.provider = "openai-compat";
      ctx.state.answers.apiBase = srv.url;
      ctx.state.answers.configureProvider = true;
      ctx.state.step = stepIndex("model");
      ctx.render();
    });
    results.appendChild(b);
  });
}

/** 2.1 — провайдер: пресеты, URL, тест и ручной скан. */
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

  if (ctx.state.answers.provider === "openai-compat" || ctx.state.answers.provider === "lmstudio") {
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

/** 2.2 — ключ: локальным серверам не нужен. */
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
