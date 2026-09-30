/**
 * First-run setup wizard for `mma web` (browser).
 *
 * Self-contained: loaded before `app.js`, exposes `window.MmaSetup.maybeOpen()`.
 * `maybeOpen()` returns a Promise<boolean> that resolves `true` when the server
 * reports `setupRequired` and the wizard has taken over the screen (it hides the
 * chat chrome via `body.setup-active` and reloads the page on success). On any
 * other case it resolves `false` and `app.js` boots the chat as usual.
 *
 * Lives outside `app.js` so the chat bundle stays focused; talks to the
 * `/api/setup*` endpoints from `setup-api.ts`. Style follows
 * docs/design/ui/STYLE.md (rows, glyphs, no boxed panels).
 */
(() => {
  "use strict";

  const token = new URLSearchParams(location.search).get("token") || "";
  const gate = document.getElementById("setupGate");

  const STEPS = ["language", "provider", "key", "model", "context", "security", "review"];

  const I18N = { locale: "en", dicts: {} };

  function tr(key, params) {
    const dict = I18N.dicts[I18N.locale] || I18N.dicts.en || {};
    const en = I18N.dicts.en || {};
    let template = dict[key];
    if (template === undefined) template = en[key];
    if (template === undefined) return key;
    if (params) {
      Object.keys(params).forEach((k) => {
        template = template.split("{" + k + "}").join(String(params[k]));
      });
    }
    return template;
  }

  function pluralCount(baseKey, n) {
    let form;
    if (I18N.locale === "ru") {
      const m10 = n % 10;
      const m100 = n % 100;
      if (m10 === 1 && m100 !== 11) form = "one";
      else if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) form = "few";
      else form = "many";
    } else {
      form = n === 1 ? "one" : "many";
    }
    const key = baseKey + "_" + form;
    const s = tr(key, { count: n });
    return s === key ? tr(baseKey, { count: n }) : s;
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (token) headers["x-mma-token"] = token;
    let res;
    try {
      res = await fetch(path, {
        method: opts.method || "GET",
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      return { ok: false, status: 0, data: null };
    }
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  }

  function h(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  async function loadI18n() {
    const r = await api("/api/i18n");
    if (r.ok && r.data) {
      I18N.locale = r.data.locale || "en";
      I18N.dicts = r.data.dicts || {};
    }
  }

  const state = {
    display: null,
    step: 0,
    answers: {
      provider: "",
      apiBase: "",
      apiKey: "",
      model: "",
      contextWindow: 32768,
      maxToolIterations: 1000,
      locale: "en",
      securityBashBlock: false,
      securityFlagsBlock: false,
      securityPathsRestrict: true,
    },
  };

  let opened = false;

  async function maybeOpen() {
    if (!gate || opened) return opened;
    const r = await api("/api/setup");
    if (!r.ok || !r.data || !r.data.required) return false;

    state.display = r.data;
    if (r.data.defaults) {
      state.answers.contextWindow = r.data.defaults.contextWindow || state.answers.contextWindow;
      state.answers.maxToolIterations =
        r.data.defaults.maxToolIterations || state.answers.maxToolIterations;
    }
    const first = (r.data.providers || [])[0];
    if (first) {
      state.answers.provider = first.type;
      if (first.baseUrl) state.answers.apiBase = first.baseUrl;
    }
    await loadI18n();
    state.answers.locale = I18N.locale || "en";

    document.body.classList.add("setup-active");
    gate.hidden = false;
    opened = true;
    render();
    return true;
  }

  // --- rendering -------------------------------------------------------------

  function render() {
    const wrap = h("div", "setup-wrap");
    const title = h("h1", "setup-h");
    title.appendChild(h("span", "glyph", "◇"));
    title.appendChild(document.createTextNode(tr("web.setup.title")));
    wrap.appendChild(title);
    wrap.appendChild(h("p", "setup-sub", tr("web.setup.subtitle")));
    wrap.appendChild(renderSteps());
    wrap.appendChild(renderBody());
    wrap.appendChild(renderActions());
    gate.innerHTML = "";
    gate.appendChild(wrap);
  }

  function renderSteps() {
    const box = h("div", "setup-steps");
    STEPS.forEach((name, i) => {
      if (i) box.appendChild(h("span", "sep", "·"));
      const cls = i === state.step ? "s on" : i < state.step ? "s done" : "s";
      box.appendChild(h("span", cls, (i < state.step ? "✓ " : "") + tr("web.setup.step." + name)));
    });
    return box;
  }

  function stepBody(name) {
    const box = h("div", "setup-step");
    box.appendChild(h("h2", "setup-step-title", tr("web.setup." + name + ".title")));
    const hint = tr("web.setup." + name + ".hint");
    if (hint !== "web.setup." + name + ".hint") box.appendChild(h("p", "setup-hint", hint));
    return box;
  }

  function field(label, input) {
    const box = h("div", "setup-field");
    box.appendChild(h("label", "setup-label", label));
    box.appendChild(input);
    return box;
  }

  function inputEl(value, type, placeholder) {
    const input = h("input", "setup-input");
    input.type = type || "text";
    input.value = value || "";
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener("input", () => {
      msg = null;
    });
    return input;
  }

  let msg = null;
  function messageEl() {
    const el = h("div", "setup-msg");
    if (msg) {
      el.className = "setup-msg " + msg.kind;
      el.textContent = msg.text;
    }
    return el;
  }
  function setMsg(box, kind, text) {
    msg = { kind, text };
    const el = box.querySelector(".setup-msg");
    if (el) {
      el.className = "setup-msg " + kind;
      el.textContent = text;
    }
  }

  function renderBody() {
    const name = STEPS[state.step];
    if (name === "language") return renderLanguage();
    if (name === "provider") return renderProvider();
    if (name === "key") return renderKey();
    if (name === "model") return renderModel();
    if (name === "context") return renderContext();
    if (name === "security") return renderSecurity();
    return renderReview();
  }

  function renderLanguage() {
    const box = stepBody("language");
    (state.display.languages || []).forEach((l) => {
      const btn = h("button", "setup-opt" + (state.answers.locale === l.value ? " on" : ""));
      btn.type = "button";
      btn.appendChild(h("span", "g", state.answers.locale === l.value ? "✓" : "◇"));
      btn.appendChild(h("span", "t", l.label));
      btn.addEventListener("click", async () => {
        state.answers.locale = l.value;
        const r = await api("/api/setup/locale", { method: "POST", body: { locale: l.value } });
        if (r.ok && r.data && r.data.dicts) {
          I18N.dicts = r.data.dicts;
          I18N.locale = l.value;
        }
        render();
      });
      box.appendChild(btn);
    });
    return box;
  }

  function renderProvider() {
    const box = stepBody("provider");
    (state.display.providers || []).forEach((p) => {
      const on = state.answers.provider === p.type;
      const btn = h("button", "setup-opt" + (on ? " on" : ""));
      btn.type = "button";
      btn.appendChild(h("span", "g", on ? "✓" : "◇"));
      btn.appendChild(h("span", "t", p.label));
      btn.addEventListener("click", () => {
        state.answers.provider = p.type;
        state.answers.apiBase = p.baseUrl || "";
        render();
      });
      box.appendChild(btn);
    });

    const input = inputEl(state.answers.apiBase, "text", "http://localhost:1234/v1");
    input.addEventListener("input", () => {
      state.answers.apiBase = input.value.trim();
    });
    box.appendChild(field(tr("web.setup.provider.base_url"), input));

    const actions = h("div", "setup-row-inline");
    const test = h("button", "setup-btn", tr("web.setup.provider.test"));
    test.type = "button";
    test.addEventListener("click", async () => {
      if (!state.answers.apiBase) {
        setMsg(box, "err", tr("web.setup.provider.required"));
        return;
      }
      test.disabled = true;
      setMsg(box, "", tr("web.setup.provider.testing"));
      const r = await api("/api/setup/models", {
        method: "POST",
        body: { baseUrl: state.answers.apiBase, apiKey: state.answers.apiKey },
      });
      test.disabled = false;
      const models = (r.ok && r.data && r.data.models) || [];
      if (r.ok && models.length) setMsg(box, "ok", tr("web.setup.provider.test_ok"));
      else setMsg(box, "warn", tr("web.setup.provider.test_fail"));
    });
    actions.appendChild(test);

    if (state.answers.provider === "openai-compat" || state.answers.provider === "lmstudio") {
      const scan = h("button", "setup-btn", tr("web.setup.provider.scan"));
      scan.type = "button";
      const results = h("div");
      scan.addEventListener("click", async () => {
        scan.disabled = true;
        setMsg(box, "", "");
        const r = await api("/api/setup/scan", { method: "POST" });
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
        results.innerHTML = "";
        servers.forEach((srv) => {
          const b = h("button", "setup-opt");
          b.type = "button";
          b.appendChild(h("span", "g", "↳"));
          b.appendChild(h("span", "t", srv.label));
          b.appendChild(h("span", "d", srv.url));
          b.addEventListener("click", () => {
            state.answers.apiBase = srv.url;
            render();
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

  function renderKey() {
    const box = stepBody("key");
    const input = inputEl(state.answers.apiKey, "password", tr("web.setup.key.placeholder"));
    input.addEventListener("input", () => {
      state.answers.apiKey = input.value;
    });
    box.appendChild(field(tr("web.setup.key.label"), input));
    box.appendChild(messageEl());
    return box;
  }

  function renderModel() {
    const box = stepBody("model");
    const input = inputEl(state.answers.model, "text", "qwen/qwen3.5-9b");
    input.addEventListener("input", () => {
      state.answers.model = input.value.trim();
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
      const r = await api("/api/setup/models", {
        method: "POST",
        body: { baseUrl: state.answers.apiBase, apiKey: state.answers.apiKey },
      });
      load.disabled = false;
      const models = (r.ok && r.data && r.data.models) || [];
      if (!models.length) {
        setMsg(box, "warn", tr("web.setup.model.load_none"));
        return;
      }
      setMsg(box, "ok", pluralCount("web.setup.model.load_found", models.length));
      results.innerHTML = "";
      models.slice(0, 20).forEach((m) => {
        const b = h("button", "setup-opt" + (state.answers.model === m ? " on" : ""));
        b.type = "button";
        b.appendChild(h("span", "g", state.answers.model === m ? "✓" : "◇"));
        b.appendChild(h("span", "t", m));
        b.addEventListener("click", () => {
          state.answers.model = m;
          input.value = m;
          render();
        });
        results.appendChild(b);
      });
    });

    test.addEventListener("click", async () => {
      if (!state.answers.model) {
        setMsg(box, "err", tr("web.setup.model.required"));
        return;
      }
      test.disabled = true;
      setMsg(box, "", tr("web.setup.model.testing"));
      const r = await api("/api/setup/test", {
        method: "POST",
        body: {
          baseUrl: state.answers.apiBase,
          apiKey: state.answers.apiKey,
          model: state.answers.model,
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

  function renderContext() {
    const box = stepBody("context");
    const cw = h("input", "setup-input");
    cw.type = "number";
    cw.min = "1024";
    cw.step = "1024";
    cw.value = String(state.answers.contextWindow);
    cw.addEventListener("input", () => {
      state.answers.contextWindow = parseInt(cw.value, 10) || 0;
    });
    box.appendChild(field(tr("web.setup.context.contextWindow"), cw));

    const detect = h("button", "setup-btn", tr("web.setup.context.detect"));
    detect.type = "button";
    detect.addEventListener("click", async () => {
      if (!state.answers.apiBase || !state.answers.model) {
        setMsg(box, "err", tr("web.setup.context.detect_fail"));
        return;
      }
      detect.disabled = true;
      setMsg(box, "", tr("web.setup.context.detecting"));
      const r = await api("/api/setup/context", {
        method: "POST",
        body: {
          baseUrl: state.answers.apiBase,
          apiKey: state.answers.apiKey,
          model: state.answers.model,
          providerType: state.answers.provider,
        },
      });
      detect.disabled = false;
      const n = r.ok && r.data && r.data.contextWindow;
      if (r.ok && r.data && r.data.ok && typeof n === "number" && n > 0) {
        state.answers.contextWindow = n;
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
    it.value = String(state.answers.maxToolIterations);
    it.addEventListener("input", () => {
      state.answers.maxToolIterations = parseInt(it.value, 10) || 0;
    });
    box.appendChild(field(tr("web.setup.context.maxToolIterations"), it));
    box.appendChild(messageEl());
    return box;
  }

  function renderSecurity() {
    const box = stepBody("security");
    const toggles = [
      ["securityPathsRestrict", "web.setup.security.paths", "web.setup.security.paths_desc"],
      ["securityBashBlock", "web.setup.security.bash", "web.setup.security.bash_desc"],
      ["securityFlagsBlock", "web.setup.security.flags", "web.setup.security.flags_desc"],
    ];
    toggles.forEach(([key, labelKey, descKey]) => {
      const row = h("label", "setup-toggle");
      const cb = h("input");
      cb.type = "checkbox";
      cb.checked = Boolean(state.answers[key]);
      cb.addEventListener("change", () => {
        state.answers[key] = cb.checked;
      });
      row.appendChild(cb);
      const texts = h("span", "setup-toggle-texts");
      texts.appendChild(h("span", "t", tr(labelKey)));
      const desc = tr(descKey);
      if (desc !== descKey) texts.appendChild(h("span", "d", desc));
      row.appendChild(texts);
      box.appendChild(row);
    });
    return box;
  }

  function securitySummary() {
    const on = [];
    if (state.answers.securityPathsRestrict) on.push(tr("web.setup.security.paths"));
    if (state.answers.securityBashBlock) on.push(tr("web.setup.security.bash"));
    if (state.answers.securityFlagsBlock) on.push(tr("web.setup.security.flags"));
    return on.length ? on.join(", ") : tr("web.setup.review.security_off");
  }

  function maskedKey() {
    const k = state.answers.apiKey;
    if (!k) return tr("web.setup.review.not_needed");
    return k.length <= 4 ? "••••" : "••••" + k.slice(-4);
  }

  function renderReview() {
    const box = stepBody("review");
    const rows = [
      [tr("web.setup.review.provider"), state.answers.provider],
      [tr("web.setup.review.baseUrl"), state.answers.apiBase],
      [tr("web.setup.review.apiKey"), maskedKey()],
      [tr("web.setup.review.model"), state.answers.model],
      [tr("web.setup.review.context"), String(state.answers.contextWindow)],
      [tr("web.setup.review.iterations"), String(state.answers.maxToolIterations)],
      [tr("web.setup.review.locale"), state.answers.locale],
      [tr("web.setup.review.security"), securitySummary()],
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

  function validate() {
    const name = STEPS[state.step];
    if (name === "provider" && !state.answers.apiBase) return tr("web.setup.provider.required");
    if (name === "model" && !state.answers.model) return tr("web.setup.model.required");
    if (name === "context") {
      if (!(state.answers.contextWindow > 0)) return tr("web.setup.context.required");
      if (!(state.answers.maxToolIterations > 0)) return tr("web.setup.context.required");
    }
    return null;
  }

  function renderActions() {
    const box = h("div", "setup-actions");
    const back = h("button", "setup-btn", tr("web.setup.back"));
    back.type = "button";
    back.disabled = state.step === 0;
    back.addEventListener("click", () => {
      if (state.step === 0) return;
      msg = null;
      state.step -= 1;
      render();
    });
    box.appendChild(back);
    box.appendChild(h("span", "spacer"));

    if (state.step < STEPS.length - 1) {
      const next = h("button", "setup-btn primary", tr("web.setup.next"));
      next.type = "button";
      next.addEventListener("click", () => {
        const err = validate();
        if (err) {
          setMsg(gate.querySelector(".setup-step"), "err", err);
          return;
        }
        msg = null;
        state.step += 1;
        render();
      });
      box.appendChild(next);
    } else {
      const finish = h("button", "setup-btn primary", tr("web.setup.finish"));
      finish.type = "button";
      finish.addEventListener("click", () => finishSetup(finish));
      box.appendChild(finish);
    }
    return box;
  }

  async function finishSetup(btn) {
    const err = validate();
    if (err) {
      setMsg(gate.querySelector(".setup-step"), "err", err);
      return;
    }
    btn.disabled = true;
    setMsg(gate.querySelector(".setup-step"), "", tr("web.setup.saving"));
    const r = await api("/api/setup", {
      method: "POST",
      body: {
        provider: state.answers.provider,
        apiBase: state.answers.apiBase,
        apiKey: state.answers.apiKey,
        model: state.answers.model,
        contextWindow: state.answers.contextWindow,
        maxToolIterations: state.answers.maxToolIterations,
        locale: state.answers.locale,
        securityBashBlock: state.answers.securityBashBlock,
        securityFlagsBlock: state.answers.securityFlagsBlock,
        securityPathsRestrict: state.answers.securityPathsRestrict,
      },
    });
    if (!r.ok) {
      btn.disabled = false;
      setMsg(gate.querySelector(".setup-step"), "err", tr("web.setup.failed"));
      return;
    }
    if (r.data && r.data.warning) {
      setMsg(
        gate.querySelector(".setup-step"),
        "warn",
        tr("web.setup.saved_warning", { warning: r.data.warning }),
      );
      setTimeout(() => location.reload(), 1500);
      return;
    }
    location.reload();
  }

  window.MmaSetup = { maybeOpen };
})();
