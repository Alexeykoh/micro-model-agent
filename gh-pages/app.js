/* MMA landing page — theme, language, MMART, terminal replay. No dependencies. */
(function () {
  "use strict";

  var root = document.documentElement;
  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- theme ---- */
  function currentTheme() {
    var saved = null;
    try { saved = localStorage.getItem("mma-lp-theme"); } catch (e) {}
    if (saved === "light" || saved === "dark") return saved;
    return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  var ICON_SUN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7"/></svg>';
  var ICON_MOON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 13.3A8.5 8.5 0 1 1 10.7 3.5a6.6 6.6 0 0 0 9.8 9.8z"/></svg>';
  function setTheme(t) {
    root.classList.toggle("light", t === "light");
    try { localStorage.setItem("mma-lp-theme", t); } catch (e) {}
    var b = document.getElementById("themeBtn");
    if (b) {
      b.innerHTML = t === "light" ? ICON_MOON : ICON_SUN;
      b.setAttribute("aria-pressed", String(t === "light"));
    }
  }

  /* ---- console theme (temporary, reversible) ---- */
  function currentConsole() {
    var saved = null;
    try { saved = localStorage.getItem("mma-lp-console"); } catch (e) {}
    if (saved === "on" || saved === "off") return saved === "on";
    return true;
  }
  function setConsole(on) {
    root.classList.toggle("console", on);
    try { localStorage.setItem("mma-lp-console", on ? "on" : "off"); } catch (e) {}
    var b = document.getElementById("consoleBtn");
    if (b) {
      b.setAttribute("aria-pressed", String(on));
      b.textContent = on ? "console" : "flat";
    }
  }

  /* ---- language ---- */
  function currentLang() {
    var saved = null;
    try { saved = localStorage.getItem("mma-lp-lang"); } catch (e) {}
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
    [['meta[name="description"]', "meta.desc"],
     ['meta[property="og:title"]', "meta.title"],
     ['meta[property="og:description"]', "meta.desc"],
     ['meta[name="twitter:title"]', "meta.title"],
     ['meta[name="twitter:description"]', "meta.desc"]
    ].forEach(function (pair) {
      var el = document.querySelector(pair[0]);
      if (el) el.setAttribute("content", lpT(pair[1]));
    });
    var onM = document.querySelector(".mstate.on");
    var nameEl = document.getElementById("mascotName");
    if (onM && nameEl) nameEl.textContent = lpT(onM.getAttribute("data-label"));
  }
  function setLang(lang) {
    root.lang = lang;
    try { localStorage.setItem("mma-lp-lang", lang); } catch (e) {}
    applyI18n();
    var b = document.getElementById("langBtn");
    if (b) b.textContent = lang === "ru" ? "EN" : "RU";
    if (window.refreshNarrow) window.refreshNarrow();
    typeTerminal(!reduce);
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
  function initHeroFace(el) {
    if (!el) return;
    el.addEventListener("click", function () {
      if (window.MMART) window.MMART.poke(el);
    });
  }

  /* ---- scroll companion ---- */
  var SECTION_STATE = {
    why: "think", terminal: "run", context: "read", tools: "find",
    planning: "plan", memory: "think", safety: "run", service: "run",
    ops: "check", start: "done", limits: "think", phil: "done"
  };
  function setFaceState(state) {
    var f = document.getElementById("compFace");
    if (!f || !window.MMART) return;
    window.MMART.setState(f, state === "track" ? "idle" : state);
  }

  /* The companion reacts to what you actually do, then returns to whatever the
     current section says it should be. */
  var sectionState = "track";
  var pulseTimer = null;
  function pulseFace(state, ms) {
    if (reduce) return;
    var wrap = document.querySelector(".companion");
    if (wrap) wrap.classList.add("show");
    setFaceState(state);
    clearTimeout(pulseTimer);
    pulseState = state;
    pulseTimer = setTimeout(function () { setFaceState(sectionState); }, ms || 1500);
  }
  var pulseState = null;

  function initCompanion() {
    var wrap = document.querySelector(".companion");
    var face = document.getElementById("compFace");
    if (!wrap || !face || reduce) return;
    var shown = false;
    if (!("IntersectionObserver" in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          if (!shown) { shown = true; wrap.classList.add("show"); }
          sectionState = SECTION_STATE[e.target.id] || "track";
          setFaceState(sectionState);
        }
      });
    }, { rootMargin: "-45% 0px -45% 0px" });
    Object.keys(SECTION_STATE).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) io.observe(el);
    });
    document.querySelectorAll(".f-node, .tag, .preset").forEach(function (n) {
      n.addEventListener("mouseenter", function () {
        if (!shown) { shown = true; wrap.classList.add("show"); }
        pulseFace("find", 900);
      });
    });
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
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var current = byId[e.target.id];
        if (!current) return;
        links.forEach(function (a) { a.classList.toggle("active", a === current); });
      });
    }, { rootMargin: "-45% 0px -45% 0px" });
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
          setTimeout(function () { btn.textContent = lpT(btn.getAttribute("data-copy")); }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, done);
        } else {
          var ta = document.createElement("textarea");
          ta.value = text; document.body.appendChild(ta); ta.select();
          try { document.execCommand("copy"); } catch (e) {}
          document.body.removeChild(ta); done();
        }
        pulseFace("done", 1800);
      });
    });
  }

  /* ---- context budget widget ---- */
  function initBudget() {
    var root = document.getElementById("budget");
    if (!root) return;
    // order: system, history, reserve (matches the web UI's segment order)
    var WINDOWS = { "32": [3, 24, 5], "64": [6, 48, 10], "128": [13, 96, 19] };
    var segs = root.querySelectorAll(".segbar i");
    var legend = root.querySelectorAll(".seglegend b");
    function apply(win) {
      var vals = WINDOWS[win];
      segs.forEach(function (s, i) { s.style.flexGrow = String(vals[i]); });
      legend.forEach(function (b, i) { b.textContent = vals[i] + "K"; });
    }
    root.querySelectorAll(".bwin").forEach(function (b) {
      b.addEventListener("click", function () {
        root.querySelectorAll(".bwin").forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on");
        apply(b.getAttribute("data-win"));
        pulseFace("think", 1300);
      });
    });
    apply("32");
  }

  /* ---- tool narrowing widget ---- */
  function initNarrow() {
    var root = document.getElementById("narrow");
    if (!root) return;
    var BASE = 1100, FULL = 3500;
    var bar = document.getElementById("narrowBar");
    var costEl = document.getElementById("narrowCost");
    var savedEl = document.getElementById("narrowSaved");
    var tags = root.querySelectorAll(".tag");
    function refresh() {
      var cost = BASE;
      tags.forEach(function (t) { if (t.classList.contains("on")) cost += parseInt(t.getAttribute("data-cost"), 10) || 0; });
      if (bar) bar.style.width = Math.max(6, Math.round(cost / FULL * 100)) + "%";
      if (costEl) costEl.textContent = (cost / 1000).toFixed(1) + "K";
      if (savedEl) savedEl.textContent = "−" + Math.round((1 - cost / FULL) * 100) + "% " + lpT("narrow.saved");
    }
    tags.forEach(function (t) {
      t.addEventListener("click", function () { t.classList.toggle("on"); refresh(); pulseFace("find", 1100); });
    });
    var reset = document.getElementById("narrowReset");
    if (reset) reset.addEventListener("click", function () {
      tags.forEach(function (t) {
        var def = t.classList.contains("file") || t.classList.contains("code");
        t.classList.toggle("on", def);
      });
      refresh();
      pulseFace("think", 1300);
    });
    window.refreshNarrow = refresh;
    refresh();
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
      timer = setTimeout(function () { bubble.classList.remove("show"); }, 2200);
    });
  }

  /* ---- reveal + progress ---- */
  function initReveal() {
    if (reduce || !("IntersectionObserver" in window)) return;
    var els = document.querySelectorAll(".sec");
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    els.forEach(function (el) { el.classList.add("reveal"); io.observe(el); });
  }
  function initProgress() {
    var bar = document.getElementById("progressBar");
    if (!bar) return;
    var sc = document.getElementById("scroll-root");
    var src = sc || window;
    function upd() {
      var h = sc ? sc.scrollHeight - sc.clientHeight : document.documentElement.scrollHeight - window.innerHeight;
      var y = sc ? sc.scrollTop : window.scrollY;
      var p = h > 0 ? (y / h) * 100 : 0;
      bar.style.width = Math.min(100, Math.max(0, p)) + "%";
    }
    src.addEventListener("scroll", upd, { passive: true });
    addEventListener("resize", upd);
    upd();
  }

  /* ---- mascot lab ---- */
  var FACE_COLORS = ["c-active", "c-recon", "c-mutate", "c-exec", "c-ok", "c-warn", "c-err", "c-dim"];
  function initMascot() {
    var big = document.getElementById("mascotBig");
    if (!big) return;
    var nameEl = document.getElementById("mascotName");
    var strip = document.querySelector(".mascot-strip");
    var btns = Array.prototype.slice.call(document.querySelectorAll(".mstate"));
    var more = document.getElementById("mstateMore");

    // show the first nine; the rest live behind "more"
    var plain = btns.filter(function (b) { return !b.classList.contains("more"); });
    plain.slice(9).forEach(function (b) { b.classList.add("more-hide"); });

    function paintBig(fromBtn) {
      var face = fromBtn ? fromBtn.querySelector(".mdl") : null;
      FACE_COLORS.forEach(function (c) { big.classList.remove(c); });
      if (face) {
        face.className.split(/\s+/).forEach(function (c) {
          if (c.indexOf("c-") === 0) big.classList.add(c);
        });
      }
    }

    plain.forEach(function (b) {
      b.addEventListener("click", function () {
        var st = b.getAttribute("data-state");
        plain.forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on");
        if (window.MMART) window.MMART.setState(big, st === "track" ? "idle" : st);
        paintBig(b);
        if (nameEl) nameEl.textContent = lpT(b.getAttribute("data-label"));
        pulseFace(st === "track" ? "find" : st, 1700);
      });
    });

    if (more && strip) {
      more.addEventListener("click", function () {
        var open = strip.classList.toggle("open");
        more.classList.toggle("on", open);
        more.setAttribute("aria-expanded", String(open));
        var lbl = document.getElementById("mstateMoreLabel");
        if (lbl) lbl.textContent = lpT(open ? "mascot.less" : "mascot.more");
        pulseFace("think", 1200);
      });
    }
    paintBig(document.querySelector(".mstate.on"));
  }

  /* ---- back to top ---- */
  function initToTop() {
    var btn = document.getElementById("toTop");
    if (!btn) return;
    var sc = document.getElementById("scroll-root");
    function upd() { btn.classList.toggle("show", (sc ? sc.scrollTop : window.scrollY) > 600); }
    (sc || window).addEventListener("scroll", upd, { passive: true });
    addEventListener("resize", upd);
    upd();
    btn.addEventListener("click", function () {
      var o = { top: 0, behavior: reduce ? "auto" : "smooth" };
      if (sc) sc.scrollTo(o); else window.scrollTo(o);
      pulseFace("done", 1400);
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
        pulseFace("run", 1200);
      });
    });
    setOs("unix");
  }

  /* ---- boot ---- */
  function boot() {
    setConsole(currentConsole());
    setTheme(currentTheme());
    setLang(currentLang());

    document.querySelectorAll(".mdl").forEach(mountFace);
    initHeroFace(document.getElementById("heroFace"));
    if (!reduce) {
      addEventListener("mousemove", function (e) {
        if (window.MMART) window.MMART.lookAt(e.clientX, e.clientY);
      }, { passive: true });
    }
    initGreeting();
    initMascot();
    initBudget();
    initNarrow();
    initCompanion();
    initNavSpy();
    initReveal();
    initProgress();
    initToTop();
    initCopy();
    initInstall();

    var replay = document.getElementById("termReplay");
    if (replay) replay.addEventListener("click", function () { typeTerminal(!reduce); pulseFace("type", 1800); });

    if (window.MMA_VERSION) {
      var v = "v" + window.MMA_VERSION;
      ["verChip", "heroVer"].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) { el.textContent = v; el.hidden = false; }
      });
    }

    var themeBtn = document.getElementById("themeBtn");
    if (themeBtn) themeBtn.addEventListener("click", function () {
      setTheme(root.classList.contains("light") ? "dark" : "light");
      pulseFace("compact", 1200);
    });
    var consoleBtn = document.getElementById("consoleBtn");
    if (consoleBtn) consoleBtn.addEventListener("click", function () {
      setConsole(!root.classList.contains("console"));
      pulseFace("compact", 1000);
    });
    var langBtn = document.getElementById("langBtn");
    if (langBtn) langBtn.addEventListener("click", function () {
      setLang(root.lang === "ru" ? "en" : "ru");
      pulseFace("run", 1200);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
