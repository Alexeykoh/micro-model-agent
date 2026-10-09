/* MMA landing page — theme, language, mascot behaviour. No dependencies. */
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
  function setTheme(t) {
    root.classList.toggle("light", t === "light");
    try { localStorage.setItem("mma-lp-theme", t); } catch (e) {}
    var b = document.getElementById("themeBtn");
    if (b) { b.textContent = t === "light" ? "☀" : "☾"; b.setAttribute("aria-pressed", String(t === "light")); }
  }

  /* ---- language ---- */
  function currentLang() {
    var saved = null;
    try { saved = localStorage.getItem("mma-lp-lang"); } catch (e) {}
    if (saved === "ru" || saved === "en") return saved;
    var nav = (navigator.language || "en").slice(0, 2).toLowerCase();
    return nav === "ru" ? "ru" : "en";
  }
  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      el.textContent = lpT(el.getAttribute("data-i18n"));
    });
    var t = document.title;
    document.title = lpT("meta.title");
    var desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute("content", lpT("meta.desc"));
    return t;
  }
  function setLang(lang) {
    root.lang = lang;
    try { localStorage.setItem("mma-lp-lang", lang); } catch (e) {}
    applyI18n();
    var b = document.getElementById("langBtn");
    if (b) b.textContent = lang === "ru" ? "EN" : "RU";
  }

  /* ---- MMART face ---- */
  var STATES = ["track", "think", "read", "find", "run", "edit", "web", "done", "error"];

  function faceHtml(extra) {
    return '<span class="eyes"><i class="eye left"></i><i class="eye right"></i></span>' +
      '<span class="orb" aria-hidden="true"><i></i></span>' +
      '<span class="dust" aria-hidden="true"><i></i><i></i><i></i></span>';
  }
  function mountFace(el) {
    if (el && !el.querySelector(".eyes")) el.innerHTML = faceHtml();
  }

  function setFaceState(state) {
    var f = document.getElementById("compFace");
    if (!f) return;
    STATES.forEach(function (s) { f.classList.remove("st-" + s); });
    f.classList.add("st-" + (state || "track"));
  }

  /* hero face: eyes follow the cursor, click blinks */
  function initHeroFace(el) {
    if (!el) return;
    mountFace(el);
    var eyes = el.querySelector(".eyes");
    if (!reduce) {
      addEventListener("mousemove", function (e) {
        var r = el.getBoundingClientRect();
        var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        var ex = Math.max(-1, Math.min(1, (e.clientX - cx) / 420));
        var ey = Math.max(-1, Math.min(1, (e.clientY - cy) / 420));
        eyes.style.left = (ex * 12).toFixed(1) + "%";
        eyes.style.top = "calc(" + (ey * 12).toFixed(1) + "% + var(--ey, 0px))";
      }, { passive: true });
    }
    el.addEventListener("click", function () {
      el.classList.add("blink-once");
      setTimeout(function () { el.classList.remove("blink-once"); }, 180);
    });
  }

  /* scroll companion: state follows the section in view */
  var SECTION_STATE = {
    why: "think", start: "run", features: "read",
    frontends: "web", serve: "run", phil: "done"
  };
  function initCompanion() {
    var wrap = document.querySelector(".companion");
    var face = document.getElementById("compFace");
    if (!wrap || !face) return;
    mountFace(face);
    if (reduce) return;

    var shown = false;
    function show() { if (!shown) { shown = true; wrap.classList.add("show"); } }

    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { show(); setFaceState(SECTION_STATE[e.target.id] || "track"); }
        });
      }, { rootMargin: "-45% 0px -45% 0px" });
      Object.keys(SECTION_STATE).forEach(function (id) {
        var el = document.getElementById(id);
        if (el) io.observe(el);
      });
    }

    // capability hover overrides, then returns to the section state
    document.querySelectorAll(".card[data-state]").forEach(function (c) {
      c.addEventListener("mouseenter", function () { show(); setFaceState(c.getAttribute("data-state")); });
      c.addEventListener("mouseleave", function () {
        var active = document.querySelector(".sect:target") || null;
        setFaceState("track");
      });
    });
  }

  /* ---- copy install command ---- */
  function initCopy() {
    var btn = document.getElementById("copyBtn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var cmd = document.getElementById("installCmd");
      var text = cmd ? cmd.textContent.trim() : "";
      var done = function () {
        btn.textContent = lpT("start.copied");
        setTimeout(function () { btn.textContent = lpT("start.copy"); }, 1500);
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
  }

  /* ---- version chip ---- */
  function initVersion() {
    var el = document.getElementById("verChip");
    if (el && window.MMA_VERSION) el.textContent = "v" + window.MMA_VERSION;
  }

  /* ---- boot ---- */
  function boot() {
    var theme = currentTheme();
    setTheme(theme);
    var lang = currentLang();
    setLang(lang);

    var themeBtn = document.getElementById("themeBtn");
    if (themeBtn) themeBtn.addEventListener("click", function () {
      setTheme(root.classList.contains("light") ? "dark" : "light");
    });
    var langBtn = document.getElementById("langBtn");
    if (langBtn) langBtn.addEventListener("click", function () {
      setLang((root.lang === "ru") ? "en" : "ru");
    });

    document.querySelectorAll(".mdl").forEach(mountFace);
    initHeroFace(document.getElementById("heroFace"));
    initCompanion();
    initCopy();
    initVersion();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
