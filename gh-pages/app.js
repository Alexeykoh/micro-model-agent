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
    var d = document.querySelector('meta[name="description"]');
    if (d) d.setAttribute("content", lpT("meta.desc"));
  }
  function setLang(lang) {
    root.lang = lang;
    try { localStorage.setItem("mma-lp-lang", lang); } catch (e) {}
    applyI18n();
    var b = document.getElementById("langBtn");
    if (b) b.textContent = lang === "ru" ? "EN" : "RU";
    typeTerminal(!reduce);
  }

  /* ---- MMART faces ---- */
  var STATES = ["track", "think", "read", "find", "run", "edit", "web", "done", "error"];
  function mountFace(el) {
    if (el && !el.querySelector(".eyes")) {
      el.innerHTML = '<span class="eyes"><i class="eye left"></i><i class="eye right"></i></span>' +
        '<span class="orb" aria-hidden="true"><i></i></span>' +
        '<span class="dust" aria-hidden="true"><i></i><i></i><i></i></span>' +
        '<span class="spark" aria-hidden="true"></span>' +
        '<span class="star" aria-hidden="true"></span>';
    }
  }
  function initHeroFace(el) {
    if (!el) return;
    var eyes = el.querySelector(".eyes");
    if (!reduce) {
      addEventListener("mousemove", function (e) {
        var r = el.getBoundingClientRect();
        var ex = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / 460));
        var ey = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / 460));
        eyes.style.left = (ex * 12).toFixed(1) + "%";
        eyes.style.top = "calc(" + (ey * 12).toFixed(1) + "% + var(--ey, 0px))";
      }, { passive: true });
    }
    el.addEventListener("click", function () {
      el.classList.add("blink-once");
      setTimeout(function () { el.classList.remove("blink-once"); }, 180);
    });
  }

  /* ---- scroll companion ---- */
  var SECTION_STATE = {
    why: "think", terminal: "run", context: "read", tools: "find",
    moe: "edit", memory: "think", safety: "run", service: "run",
    install: "done", phil: "done"
  };
  function setFaceState(state) {
    var f = document.getElementById("compFace");
    if (!f) return;
    STATES.forEach(function (s) { f.classList.remove("st-" + s); });
    f.classList.add("st-" + (state || "track"));
  }
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
          setFaceState(SECTION_STATE[e.target.id] || "track");
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
        setFaceState("find");
      });
      n.addEventListener("mouseleave", function () { setFaceState("track"); });
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
  function typeTerminal(animate) {
    var body = document.getElementById("termBody");
    if (!body) return;
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
      });
    });
  }

  /* ---- boot ---- */
  function boot() {
    setTheme(currentTheme());
    setLang(currentLang());

    document.querySelectorAll(".mdl").forEach(mountFace);
    initHeroFace(document.getElementById("heroFace"));
    initCompanion();
    initCopy();

    var replay = document.getElementById("termReplay");
    if (replay) replay.addEventListener("click", function () { typeTerminal(!reduce); });

    var el = document.getElementById("verChip");
    if (el && window.MMA_VERSION) el.textContent = "v" + window.MMA_VERSION;

    var themeBtn = document.getElementById("themeBtn");
    if (themeBtn) themeBtn.addEventListener("click", function () {
      setTheme(root.classList.contains("light") ? "dark" : "light");
    });
    var langBtn = document.getElementById("langBtn");
    if (langBtn) langBtn.addEventListener("click", function () {
      setLang(root.lang === "ru" ? "en" : "ru");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
