/* MMA landing page — theme, language, MMART, terminal replay. No dependencies. */
(function () {
  "use strict";

  var root = document.documentElement;
  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- theme ---- */
  function currentTheme() {
    var saved = null;
    try {
      saved = localStorage.getItem("mma-lp-theme");
    } catch (e) {}
    if (saved === "light" || saved === "dark") return saved;
    return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  var ICON_SUN =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7"/></svg>';
  var ICON_MOON =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 13.3A8.5 8.5 0 1 1 10.7 3.5a6.6 6.6 0 0 0 9.8 9.8z"/></svg>';
  function setTheme(t) {
    root.classList.toggle("light", t === "light");
    try {
      localStorage.setItem("mma-lp-theme", t);
    } catch (e) {}
    var b = document.getElementById("themeBtn");
    if (b) {
      b.innerHTML = t === "light" ? ICON_MOON : ICON_SUN;
      b.setAttribute("aria-pressed", String(t === "light"));
    }
  }

  /* ---- language ---- */
  function currentLang() {
    var saved = null;
    try {
      saved = localStorage.getItem("mma-lp-lang");
    } catch (e) {}
    if (saved === "ru" || saved === "en") return saved;
    return (navigator.language || "en").slice(0, 2).toLowerCase() === "ru" ? "ru" : "en";
  }
  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      if (el.hasAttribute("data-i18n-html")) el.innerHTML = lpT(key);
      else el.textContent = lpT(key);
    });
    document.querySelectorAll("[data-copy]").forEach(function (b) {
      b.textContent = lpT(b.getAttribute("data-copy"));
    });
    document.title = lpT("meta.title");
    [
      ['meta[name="description"]', "meta.desc"],
      ['meta[property="og:title"]', "meta.title"],
      ['meta[property="og:description"]', "meta.desc"],
      ['meta[name="twitter:title"]', "meta.title"],
      ['meta[name="twitter:description"]', "meta.desc"],
    ].forEach(function (pair) {
      var el = document.querySelector(pair[0]);
      if (el) el.setAttribute("content", lpT(pair[1]));
    });
  }
  function setLang(lang) {
    root.lang = lang;
    try {
      localStorage.setItem("mma-lp-lang", lang);
    } catch (e) {}
    applyI18n();
    var b = document.getElementById("langBtn");
    if (b) b.textContent = lang === "ru" ? "EN" : "RU";
    typeTerminal(!reduce);
    paintStage();
  }

  /* ---- MMART faces ---- */
  function mountFace(el) {
    if (!el || !window.MMART) return;
    var state = "idle";
    el.className.split(/\s+/).forEach(function (c) {
      if (c.indexOf("st-") === 0) state = c.slice(3);
    });
    window.MMART.attach(el, state);
  }

  /* ---- nav scroll-spy ---- */
  function initNavSpy() {
    var links = Array.prototype.slice.call(document.querySelectorAll(".links a[href^='#']"));
    if (!links.length || !("IntersectionObserver" in window)) return;
    var byId = {};
    links.forEach(function (a) {
      var id = a.getAttribute("href").slice(1);
      if (id) byId[id] = a;
    });
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          var current = byId[e.target.id];
          if (!current) return;
          links.forEach(function (a) {
            a.classList.toggle("active", a === current);
          });
        });
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    Object.keys(byId).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) io.observe(el);
    });
  }

  /* ---- terminal transcript ---- */
  function classify(t) {
    if (t.charAt(0) === "$") return "cmd";
    if (t.indexOf("◇") === 0) return /plan|план/.test(t) ? "plan" : "cmd";
    if (t.indexOf("✦") === 0) return "think";
    if (t.indexOf("✓") === 0) return "ok";
    return "meta";
  }
  // Monotonic run id: every restart cancels the previous typing loop, so the
  // boot / language-switch / replay calls can never type into the same #termBody
  // concurrently (that produced duplicated lines and several cursors).
  var termRun = 0;
  function typeTerminal(animate) {
    var body = document.getElementById("termBody");
    if (!body) return;
    var run = ++termRun;
    var lines = (body.getAttribute("data-lines") || "").split(",").map(lpT);
    body.innerHTML = "";
    if (!animate) {
      lines.forEach(function (t) {
        var s = document.createElement("span");
        s.className = "ln " + classify(t);
        s.textContent = t;
        body.appendChild(s);
      });
      return;
    }
    var i = 0;
    (function nextLine() {
      if (run !== termRun) return;
      if (i >= lines.length) {
        var c = document.createElement("span");
        c.className = "cursor";
        body.appendChild(c);
        return;
      }
      var t = lines[i++];
      var s = document.createElement("span");
      s.className = "ln " + classify(t);
      body.appendChild(s);
      var n = 0;
      (function typeChar() {
        if (run !== termRun) return;
        s.textContent = t.slice(0, ++n);
        if (n < t.length) setTimeout(typeChar, 11);
        else setTimeout(nextLine, 240);
      })();
    })();
  }

  /* ---- copy buttons ---- */
  function initCopy() {
    document.querySelectorAll(".copy[data-target]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var src = document.getElementById(btn.getAttribute("data-target"));
        var text = src ? src.textContent.trim() : "";
        var done = function () {
          btn.textContent = lpT(btn.getAttribute("data-copied"));
          setTimeout(function () {
            btn.textContent = lpT(btn.getAttribute("data-copy"));
          }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, done);
        } else {
          var ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          try {
            document.execCommand("copy");
          } catch (e) {}
          document.body.removeChild(ta);
          done();
        }
      });
    });
  }

  /* ---- context budget widget ---- */
  function initBudget() {
    var root = document.getElementById("budget");
    if (!root) return;
    // order: system, history, reserve (matches the web UI's segment order)
    var WINDOWS = { 32: [3, 24, 5], 64: [6, 48, 10], 128: [13, 96, 19] };
    var segs = root.querySelectorAll(".segbar i");
    var legend = root.querySelectorAll(".seglegend b");
    function apply(win) {
      var vals = WINDOWS[win];
      segs.forEach(function (s, i) {
        s.style.flexGrow = String(vals[i]);
      });
      legend.forEach(function (b, i) {
        b.textContent = vals[i] + "K";
      });
    }
    root.querySelectorAll(".bwin").forEach(function (b) {
      b.addEventListener("click", function () {
        root.querySelectorAll(".bwin").forEach(function (x) {
          x.classList.remove("on");
        });
        b.classList.add("on");
        apply(b.getAttribute("data-win"));
      });
    });
    apply("32");
  }

  /* ---- safety pipeline: click a stage to see what actually happens ---- */
  var STAGES = {
    en: {
      call: {
        tag: "before",
        d: "The model returns a tool call. Nothing has touched the filesystem or the network yet — the call is still just a name and a set of arguments.",
        list: [
          "Tool name and arguments are read from the model response",
          "The call is matched against the enabled tool set and the session allowlist",
          "An interactive tool asks the user first instead of running",
        ],
      },
      "plugins-in": {
        tag: "extensibility",
        d: "Before the validators, enabled plugins see the call. A plugin can rewrite arguments, attach metadata or refuse the call — the refusal is what the audit journal records.",
        list: [
          "Runs only for plugins enabled in this project",
          "A plugin can mutate the arguments before validation",
          "A plugin refusal is a block, not a silent skip",
        ],
      },
      validators: {
        tag: "the gate",
        d: "One enforcement point. Every tool declares what it needs — capabilities, path arguments, URL arguments — and the validators check the call against the active policy before anything happens.",
        list: [
          "Command: blacklist, dangerous flags, optional allowlist, interpreter escapes",
          "Path: always-on protected paths, workspace containment, subagent file zones",
          "Network: SSRF policy with DNS resolution, domain blacklist, optional allowlist",
          "Content: eval( and child_process.exec( style patterns are flagged before a write",
        ],
      },
      action: {
        tag: "execution",
        d: "The tool runs. Path arguments are resolved with realpath so a symlink or junction cannot escape the workspace, and the result is capped before it enters the context.",
        list: [
          "Symlinks and junctions are resolved, not trusted",
          "Output is truncated and control characters are stripped",
          "A long-running command is backgrounded instead of blocking the turn",
        ],
      },
      "plugins-out": {
        tag: "extensibility",
        d: "The result goes back through the plugin chain. This is where a plugin can redact what the model is about to see — the model-facing text and the audit record are not the same string.",
        list: [
          "A plugin can rewrite or truncate the result",
          "Redaction applied here is what the model actually receives",
          "Failures are caught per plugin: one broken plugin does not stop the others",
        ],
      },
      result: {
        tag: "after",
        d: "The result returns to the loop with its provenance: whether it was blocked, which policy decided, and what was redacted. A block never reaches the tool, and it is never silent.",
        list: [
          "Blocked calls are written to the audit journal with the reason",
          "Protected-path and egress hits are reported, not swallowed",
          "The model sees a calm one-line summary, never the raw directive",
        ],
      },
    },
    ru: {
      call: {
        tag: "до",
        d: "Модель вернула вызов инструмента. Файловая система и сеть ещё не тронуты — это только имя и набор аргументов.",
        list: [
          "Имя инструмента и аргументы читаются из ответа модели",
          "Вызов сверяется с включённым набором и allowlist сессии",
          "Интерактивный инструмент сначала спрашивает пользователя",
        ],
      },
      "plugins-in": {
        tag: "расширяемость",
        d: "Перед валидаторами вызов видят включённые плагины. Плагин может переписать аргументы, добавить метаданные или отказать в вызове — отказ пишется в аудит-журнал.",
        list: [
          "Работает только для плагинов, включённых в этом проекте",
          "Плагин может изменить аргументы до валидации",
          "Отказ плагина — это блокировка, а не тихий пропуск",
        ],
      },
      validators: {
        tag: "шлюз",
        d: "Одна точка enforcement. Каждый инструмент объявляет, что ему нужно — возможности, пути, URL, — и валидаторы проверяют вызов по активной политике до того, как что-то произойдёт.",
        list: [
          "Команды: чёрный список, опасные флаги, опциональный белый, лазейки через интерпретаторы",
          "Пути: всегда включённые защищённые пути, удержание в рабочей папке, зоны субагентов",
          "Сеть: SSRF-политика с DNS-резолвом, чёрный список доменов, опциональный белый",
          "Содержимое: паттерны вроде eval( и child_process.exec( помечаются до записи",
        ],
      },
      action: {
        tag: "исполнение",
        d: "Инструмент выполняется. Пути резолвятся через realpath, поэтому симлинк или junction не выведут за пределы рабочей папки, а результат обрезается до попадания в контекст.",
        list: [
          "Симлинки и junction резолвятся, а не доверяются",
          "Вывод обрезается, управляющие символы вычищаются",
          "Длинная команда уходит в фон вместо блокировки хода",
        ],
      },
      "plugins-out": {
        tag: "расширяемость",
        d: "Результат возвращается через цепочку плагинов. Здесь плагин может вычистить то, что увидит модель, — текст для модели и запись в аудите не одно и то же.",
        list: [
          "Плагин может переписать или обрезать результат",
          "Редакция здесь — это то, что реально получит модель",
          "Сбои ловятся по одному: один сломанный плагин не останавливает остальные",
        ],
      },
      result: {
        tag: "после",
        d: "Результат возвращается в петлю с происхождением: был ли вызов заблокирован, какое правило решило и что вычищено. Блокировка не доходит до инструмента и никогда не молчит.",
        list: [
          "Заблокированные вызовы пишутся в аудит-журнал с причиной",
          "Срабатывания по защищённым путям и egress сообщаются, а не глотаются",
          "Модель видит спокойную строку-итог, а не сырую директиву",
        ],
      },
    },
  };
  var stageKey = null;
  function paintStage() {
    var pipe = document.getElementById("safetyPipe");
    var panel = document.getElementById("safetyStage");
    if (!pipe || !panel || !stageKey) return;
    var lang = root.lang === "ru" ? "ru" : "en";
    var data = (STAGES[lang] || STAGES.en)[stageKey];
    if (!data) return;
    var nodes = pipe.querySelectorAll(".pipe-node");
    var idx = 0;
    nodes.forEach(function (n) {
      var on = n.getAttribute("data-stage") === stageKey;
      n.classList.toggle("on", on);
      n.setAttribute("aria-expanded", String(on));
      if (on) idx = Array.prototype.indexOf.call(nodes, n) + 1;
    });
    document.getElementById("safetyStageN").textContent = idx + "/" + nodes.length;
    document.getElementById("safetyStageTitle").textContent =
      pipe.querySelector('[data-stage="' + stageKey + '"]').textContent;
    document.getElementById("safetyStageTag").textContent = data.tag;
    document.getElementById("safetyStageD").textContent = data.d;
    var ul = document.getElementById("safetyStageList");
    ul.textContent = "";
    data.list.forEach(function (item) {
      var li = document.createElement("li");
      li.textContent = item;
      ul.appendChild(li);
    });
    panel.hidden = false;
  }
  function initSafetyPipe() {
    var pipe = document.getElementById("safetyPipe");
    if (!pipe) return;
    pipe.querySelectorAll(".pipe-node").forEach(function (n) {
      n.addEventListener("click", function () {
        stageKey = stageKey === n.getAttribute("data-stage") ? null : n.getAttribute("data-stage");
        paintStage();
      });
    });
  }

  /* ---- MMART greeting ---- */
  function initGreeting() {
    var face = document.getElementById("heroFace");
    var bubble = document.getElementById("greet");
    if (!face || !bubble || reduce) return;
    var timer = null;
    face.addEventListener("click", function () {
      bubble.textContent = lpT("greet");
      bubble.classList.add("show");
      clearTimeout(timer);
      timer = setTimeout(function () {
        bubble.classList.remove("show");
      }, 2200);
    });
  }

  /* ---- reveal + progress ---- */
  function initReveal() {
    var els = document.querySelectorAll(".sec");
    if (reduce || !("IntersectionObserver" in window)) {
      els.forEach(function (el) {
        el.classList.add("in");
      });
      return;
    }
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
    );
    els.forEach(function (el) {
      el.classList.add("reveal");
      io.observe(el);
    });
    // Safety net: a reveal that never fires (observer unsupported, page
    // printed, embedded in a viewer) must not leave the page blank.
    setTimeout(function () {
      els.forEach(function (el) {
        el.classList.add("in");
      });
    }, 4000);
  }
  function initProgress() {
    var bar = document.getElementById("progressBar");
    if (!bar) return;
    var sc = document.getElementById("scroll-root");
    var src = sc || window;
    function upd() {
      var h = sc
        ? sc.scrollHeight - sc.clientHeight
        : document.documentElement.scrollHeight - window.innerHeight;
      var y = sc ? sc.scrollTop : window.scrollY;
      var p = h > 0 ? (y / h) * 100 : 0;
      bar.style.width = Math.min(100, Math.max(0, p)) + "%";
    }
    src.addEventListener("scroll", upd, { passive: true });
    addEventListener("resize", upd);
    upd();
  }

  /* ---- back to top ---- */
  function initToTop() {
    var btn = document.getElementById("toTop");
    if (!btn) return;
    var sc = document.getElementById("scroll-root");
    function upd() {
      btn.classList.toggle("show", (sc ? sc.scrollTop : window.scrollY) > 600);
    }
    (sc || window).addEventListener("scroll", upd, { passive: true });
    addEventListener("resize", upd);
    upd();
    btn.addEventListener("click", function () {
      var o = { top: 0, behavior: reduce ? "auto" : "smooth" };
      if (sc) sc.scrollTo(o);
      else window.scrollTo(o);
    });
  }

  /* ---- hero install widget ---- */
  function initInstall() {
    var root = document.getElementById("install");
    var cmd = document.getElementById("installCmd");
    if (!root || !cmd) return;
    var tabs = Array.prototype.slice.call(root.querySelectorAll(".itab"));
    function setOs(os) {
      var text = cmd.getAttribute(os === "win" ? "data-win" : "data-unix");
      if (text) cmd.textContent = text;
      tabs.forEach(function (t) {
        var on = t.getAttribute("data-os") === os;
        t.classList.toggle("on", on);
        t.setAttribute("aria-selected", String(on));
      });
    }
    tabs.forEach(function (t) {
      t.addEventListener("click", function () {
        setOs(t.getAttribute("data-os"));
      });
    });
    setOs("unix");
  }

  /* ---- mobile navigation (burger) ---- */
  function initBurger() {
    var btn = document.getElementById("burgerBtn");
    var nav = document.getElementById("siteLinks");
    if (!btn || !nav) return;
    function setOpen(open) {
      document.body.classList.toggle("nav-open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }
    btn.addEventListener("click", function () {
      setOpen(!document.body.classList.contains("nav-open"));
    });
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") setOpen(false);
    });
    document.addEventListener("click", function (e) {
      if (!document.body.classList.contains("nav-open")) return;
      if (!e.target.closest("#siteLinks") && !e.target.closest("#burgerBtn")) setOpen(false);
    });
    addEventListener(
      "resize",
      function () {
        if (innerWidth > 1180) setOpen(false);
      },
      { passive: true },
    );
  }

  function boot() {
    setTheme(currentTheme());
    setLang(currentLang());

    document.querySelectorAll(".mdl").forEach(mountFace);
    if (!reduce) {
      addEventListener(
        "mousemove",
        function (e) {
          if (window.MMART) window.MMART.lookAt(e.clientX, e.clientY);
        },
        { passive: true },
      );
    }
    initGreeting();
    initSafetyPipe();
    initBudget();
    initNavSpy();
    initReveal();
    initProgress();
    initToTop();
    initCopy();
    initInstall();
    initBurger();

    var replay = document.getElementById("termReplay");
    if (replay)
      replay.addEventListener("click", function () {
        typeTerminal(!reduce);
      });

    if (window.MMA_VERSION) {
      var v = "v" + window.MMA_VERSION;
      ["verChip", "heroVer"].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) {
          el.textContent = v;
          el.hidden = false;
        }
      });
    }

    var themeBtn = document.getElementById("themeBtn");
    if (themeBtn)
      themeBtn.addEventListener("click", function () {
        setTheme(root.classList.contains("light") ? "dark" : "light");
      });
    var langBtn = document.getElementById("langBtn");
    if (langBtn)
      langBtn.addEventListener("click", function () {
        setLang(root.lang === "ru" ? "en" : "ru");
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
