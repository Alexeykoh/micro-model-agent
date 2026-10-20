# GitHub Pages Landing Implementation Plan

> **Статус:** исполнено (2026-10-20) — лендинг в `gh-pages/` реализован и с тех пор развит
> (`2d983479` — «refresh the site and guard it against drift»). Структура отличается от плана:
> нумерованные секции вместо карточек, другие ключи i18n, якоря переименованы.
> Не сделано: опциональный smoke-тест `tests/landing-page.test.ts`. Чекбоксы проставлены по факту.

**Goal:** Build a static, build-free landing page under `gh-pages/` that presents MMA to developers evaluating it for local small models.

**Architecture:** Plain HTML/CSS/JS served as-is by GitHub Pages. Design tokens are copied from the webui `styles.css` so the page matches the app; the MMART face is a vendored subset of the webui `.mdl` component with a small state mapper. Theme and language are `localStorage`-backed and applied on load before paint.

**Tech Stack:** HTML5, CSS custom properties (dark + `body.light`), vanilla ES modules-free JS (plain `<script defer>`), no dependencies.

**Spec:** `docs/specs/2026-10-10-gh-pages-landing-design.md`

---

## File Structure

```
gh-pages/
  index.html    — markup; `data-i18n` keys; section anchors
  styles.css    — tokens (dark + light), layout, section styling
  mascot.css    — vendored `.mdl` face (track/think/read/find/run/edit/web/done/error)
  app.js        — boot: apply theme+lang; nav toggles; copy button; mascot cursor;
                  scroll companion; capability hover; reduced-motion guard
  i18n.js       — `LP_I18N = { ru: {...}, en: {...} }` + `lpT(key)`
  favicon.svg   — the face as an icon
```

Load order in `index.html`: `i18n.js` → `app.js` (defer), styles in `<head>`.

---

## Task 1: Skeleton, tokens, i18n, boot

**Files:**
- Create: `gh-pages/index.html`
- Create: `gh-pages/styles.css`
- Create: `gh-pages/i18n.js`
- Create: `gh-pages/app.js`

- [x] **Step 1: Create `gh-pages/styles.css` with tokens copied from webui**

Copy the `:root` block (dark) and the `body.light` override block from
`src/modules/webui/assets/styles.css` (lines ~2–120). Keep the token names
identical. Then add landing-only structure at the bottom:

```css
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
a { color: var(--accent); }
.wrap { width: min(1080px, 92vw); margin: 0 auto; }
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
```

- [x] **Step 2: Create `gh-pages/i18n.js`**

```js
window.LP_I18N = {
  en: {
    "nav.why": "Why", "nav.start": "Quick start", "nav.features": "Features",
    "nav.frontends": "Interfaces", "nav.serve": "Service", "nav.docs": "Docs",
    "hero.headline": "Micro models, big tasks",
    "hero.sub": "A harness-agent that keeps local 32K–64K models on task.",
    "hero.install": "Install", "hero.github": "GitHub",
    "why.title": "Small models lose the thread",
    "cap.title": "Capabilities",
    "frontends.title": "One core, two interfaces",
    "serve.title": "Service mode",
    "footer.license": "MIT License"
    /* …remaining keys filled per section/task… */
  },
  ru: {
    "nav.why": "Почему", "nav.start": "Как запустить", "nav.features": "Возможности",
    "nav.frontends": "Интерфейсы", "nav.serve": "Сервис", "nav.docs": "Документация",
    "hero.headline": "Микро-модели, большие задачи",
    "hero.sub": "Харнесс-агент, который удерживает локальные модели 32K–64K в задаче.",
    "hero.install": "Установить", "hero.github": "GitHub",
    "why.title": "Маленькие модели теряют нить",
    "cap.title": "Возможности",
    "frontends.title": "Одно ядро, два интерфейса",
    "serve.title": "Сервисный режим",
    "footer.license": "Лицензия MIT"
  }
};
window.lpT = function (key) {
  var lang = document.documentElement.lang || "en";
  var d = window.LP_I18N[lang] || window.LP_I18N.en;
  return d[key] || window.LP_I18N.en[key] || key;
};
```

- [x] **Step 3: Create `gh-pages/index.html` skeleton**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MMA — Micro Models Agent</title>
  <link rel="icon" href="favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="styles.css">
  <link rel="stylesheet" href="mascot.css">
  <script defer src="i18n.js"></script>
  <script defer src="app.js"></script>
</head>
<body>
  <header class="nav">…</header>
  <main>…</main>
  <footer class="foot">…</footer>
</body>
</html>
```

Include an inline pre-paint script in `<head>` (before stylesheet) to avoid a
theme flash:

```html
<script>
  try {
    var th = localStorage.getItem("mma-lp-theme");
    if (th === "light") document.documentElement.classList.add("light");
    var lang = localStorage.getItem("mma-lp-lang") || (navigator.language || "en").slice(0, 2);
    document.documentElement.lang = (lang === "ru") ? "ru" : "en";
  } catch (e) {}
</script>
```

- [x] **Step 4: Create `gh-pages/app.js` boot**

```js
(function () {
  var root = document.documentElement;
  var theme = localStorage.getItem("mma-lp-theme");
  if (!theme) theme = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  root.classList.toggle("light", theme === "light");

  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      el.textContent = lpT(el.getAttribute("data-i18n"));
    });
    document.title = lpT("meta.title");
  }
  window.applyI18n = applyI18n;
  applyI18n();
})();
```

- [x] **Step 5: Verify it loads**

Run: `Start-Process gh-pages/index.html`
Expected: page opens from disk, dark background, no console errors.

- [x] **Step 6: Commit**

```bash
git add gh-pages/index.html gh-pages/styles.css gh-pages/i18n.js gh-pages/app.js
git commit -m "feat(landing): skeleton, theme tokens, i18n and boot"
```

---

## Task 2: Nav + hero + mascot component

**Files:**
- Create: `gh-pages/mascot.css`
- Modify: `gh-pages/index.html` (nav + hero)
- Modify: `gh-pages/styles.css` (nav/hero layout)
- Modify: `gh-pages/app.js` (theme/lang toggles, hero face cursor)

- [x] **Step 1: Create `gh-pages/mascot.css`**

Header comment records the source. Vendor the `.mdl`/`.eye`/`.c-*`/`.st-*` rules
from `src/modules/webui/assets/styles.css` (~lines 1958–2100), trimmed to the
subset states. Keep `.mdl { --s: ... }`, `.mdl .eyes`, `.mdl .eye`, the `blink`,
`narrow`, `squint`, `wide`, `happy`, `sleep` shape modifiers, and the state
keyframes actually referenced by the mapper in Task 7.

- [x] **Step 2: Add nav markup with toggles**

```html
<header class="nav wrap">
  <a class="brand" href="#top"><span class="mdl sm c-recon track" id="navFace" aria-hidden="true"><span class="eyes"><i class="eye left"></i><i class="eye right"></i></span></span> MMA</a>
  <nav class="links">
    <a href="#why" data-i18n="nav.why"></a>
    <a href="#start" data-i18n="nav.start"></a>
    <a href="#features" data-i18n="nav.features"></a>
    <a href="#frontends" data-i18n="nav.frontends"></a>
    <a href="#serve" data-i18n="nav.serve"></a>
  </nav>
  <div class="ctl">
    <button id="langBtn" type="button">RU</button>
    <button id="themeBtn" type="button" aria-label="toggle theme">☾</button>
    <a class="gh" href="https://github.com/Alexeykoh/micro-model-agent">GitHub</a>
  </div>
</header>
```

- [x] **Step 3: Add hero (split, face right)**

```html
<section id="top" class="hero wrap">
  <div class="hero-txt">
    <h1 data-i18n="hero.headline"></h1>
    <p data-i18n="hero.sub"></p>
    <div class="cta">
      <a class="btn" href="#start" data-i18n="hero.install"></a>
      <a class="btn ghost" href="#features" data-i18n="hero.github"></a>
    </div>
  </div>
  <div class="hero-face">
    <span class="mdl lg c-recon track blink poke" id="heroFace" aria-hidden="true">
      <span class="eyes"><i class="eye left"></i><i class="eye right"></i></span>
    </span>
  </div>
</section>
```

- [x] **Step 4: Wire toggles + cursor tracking in `app.js`**

```js
function setLang(lang) {
  root.lang = lang;
  localStorage.setItem("mma-lp-lang", lang);
  applyI18n();
  var b = document.getElementById("langBtn");
  if (b) b.textContent = lang === "ru" ? "EN" : "RU";
}
function setTheme(t) {
  root.classList.toggle("light", t === "light");
  localStorage.setItem("mma-lp-theme", t);
  var b = document.getElementById("themeBtn");
  if (b) b.textContent = t === "light" ? "☀" : "☾";
}
function initFace(el) {
  if (!el) return;
  var eyes = el.querySelector(".eyes");
  addEventListener("mousemove", function (e) {
    var r = el.getBoundingClientRect();
    var ex = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / 300));
    var ey = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / 300));
    eyes.style.transform = "translate(" + (ex * 22).toFixed(1) + "%," + (ey * 22).toFixed(1) + "%)";
  }, { passive: true });
  el.addEventListener("click", function () {
    el.classList.add("blink");
    setTimeout(function () { el.classList.remove("blink"); }, 400);
  });
}
```

Call `setLang(root.lang)`, `setTheme(current)`, `initFace(heroFace)`,
`initFace(navFace)` on boot. Under `prefers-reduced-motion`, skip `initFace`.

- [x] **Step 5: Verify**

Run: `Start-Process gh-pages/index.html`
Expected: hero shows headline+buttons left, face right; clicking RU swaps copy;
☾ toggles light; face eyes follow the cursor.

- [x] **Step 6: Commit**

```bash
git add gh-pages/mascot.css gh-pages/index.html gh-pages/styles.css gh-pages/app.js
git commit -m "feat(landing): nav, hero and MMART face"
```

---

## Task 3: Why + Quick start (copyable install)

**Files:** modify `gh-pages/index.html`, `gh-pages/styles.css`, `gh-pages/i18n.js`, `gh-pages/app.js`

- [x] **Step 1: Add copy keys** to both dicts in `i18n.js`: `why.title`, `why.b1..b3`, `start.title`, `start.note`, `start.copy`, `start.copied`.

- [x] **Step 2: Add markup**

```html
<section id="why" class="sect wrap">
  <h2 data-i18n="why.title"></h2>
  <ul class="why-list">
    <li data-i18n="why.b1"></li>
    <li data-i18n="why.b2"></li>
    <li data-i18n="why.b3"></li>
  </ul>
</section>
<section id="start" class="sect wrap">
  <h2 data-i18n="start.title"></h2>
  <div class="codebox">
    <code id="installCmd">curl -fsSL https://github.com/Alexeykoh/micro-model-agent/releases/latest/download/install.sh | bash</code>
    <button id="copyBtn" type="button" data-i18n="start.copy"></button>
  </div>
  <p class="note" data-i18n="start.note"></p>
</section>
```

- [x] **Step 3: Copy handler in `app.js`**

```js
var copy = document.getElementById("copyBtn");
if (copy) copy.addEventListener("click", function () {
  var text = document.getElementById("installCmd").textContent.trim();
  navigator.clipboard.writeText(text).then(function () {
    copy.textContent = lpT("start.copied");
    setTimeout(function () { copy.textContent = lpT("start.copy"); }, 1500);
  });
});
```

(Content copy pulled from the spec and `docs/mma-features-overview.md`;
Windows users get the `irm … | iex` alternative in `start.note`.)

- [x] **Step 4: Verify** install command copies; RU/EN both show localized note.

- [x] **Step 5: Commit** `feat(landing): why and quick start sections`

---

## Task 4: Capabilities grid (+ hover mascot states)

**Files:** modify `index.html`, `styles.css`, `i18n.js`, `app.js`

- [x] **Step 1: Keys** `cap.title`, `cap.tools`, `cap.context`, `cap.plan`, `cap.moe`, `cap.memory`, `cap.safety`, `cap.web` (+ `.d` descriptions) in both dicts.

- [x] **Step 2: Markup** — 7 cards, each `data-state`:

```html
<section id="features" class="sect wrap">
  <h2 data-i18n="cap.title"></h2>
  <div class="cards">
    <article class="card" data-state="read"><h3 data-i18n="cap.tools"></h3><p data-i18n="cap.tools.d"></p></article>
    <article class="card" data-state="think"><h3 data-i18n="cap.context"></h3><p data-i18n="cap.context.d"></p></article>
    <article class="card" data-state="edit"><h3 data-i18n="cap.plan"></h3><p data-i18n="cap.plan.d"></p></article>
    <article class="card" data-state="think"><h3 data-i18n="cap.moe"></h3><p data-i18n="cap.moe.d"></p></article>
    <article class="card" data-state="find"><h3 data-i18n="cap.memory"></h3><p data-i18n="cap.memory.d"></p></article>
    <article class="card" data-state="run"><h3 data-i18n="cap.safety"></h3><p data-i18n="cap.safety.d"></p></article>
    <article class="card" data-state="web"><h3 data-i18n="cap.web"></h3><p data-i18n="cap.web.d"></p></article>
  </div>
</section>
```

- [x] **Step 3: Hover → companion state** in `app.js`:

```js
document.querySelectorAll(".card[data-state]").forEach(function (c) {
  c.addEventListener("mouseenter", function () { setFaceState(c.getAttribute("data-state")); });
  c.addEventListener("mouseleave", function () { setFaceState(null); });
});
```

`setFaceState` is defined in Task 7; in this task add a stub that sets a class on
the section companion placeholder, then replace it in Task 7.

- [x] **Step 4: Verify** hovering each card changes the face class; grid is
  responsive (1 col below 900px, 2–3 cols above).

- [x] **Step 5: Commit** `feat(landing): capabilities grid`

---

## Task 5: Two frontends (CSS chat mini-mockup)

**Files:** modify `index.html`, `styles.css`, `i18n.js`

- [x] **Step 1: Keys** `frontends.title`, `frontends.term`, `frontends.web`, `frontends.term.d`, `frontends.web.d`.

- [x] **Step 2: Markup** — two columns; the web side is a static transcript using
  STYLE.md glyphs:

```html
<section id="frontends" class="sect wrap">
  <h2 data-i18n="frontends.title"></h2>
  <div class="two">
    <div class="pane">
      <h3 data-i18n="frontends.term"></h3>
      <pre class="mini">qwen3.5-9b · lmstudio · 32K
&gt; починить тесты
◇ Чтение файла · test/core.spec.ts
◇ Запуск команды · bun test ✓
✦ думаю · 1.2s
⟡ 6.2K tok · 18%</pre>
    </div>
    <div class="pane">
      <h3 data-i18n="frontends.web"></h3>
      <pre class="mini">◇ Reading file · src/agent.ts
◇ Running command · bun test ✓
✦ composing answer…
⟡ 6.2K tok · 18%</pre>
    </div>
  </div>
</section>
```

- [x] **Step 3: Verify** transcript renders without emoji; both themes readable.

- [x] **Step 4: Commit** `feat(landing): terminal/web interface section`

---

## Task 6: Service, philosophy, footer

**Files:** modify `index.html`, `styles.css`, `i18n.js`

- [x] **Step 1: Keys** `serve.title`, `serve.body`, `phil.title`, `phil.body`, `footer.*` links.

- [x] **Step 2: Markup** — `mma serve` paragraph + fenced request example;
  philosophy block (universal harness, deliberately not code-only); footer
  linking GitHub / README / docs / releases / MIT.

- [x] **Step 3: Verify** all footer links resolve to `https://github.com/Alexeykoh/micro-model-agent/...`.

- [x] **Step 4: Commit** `feat(landing): service, philosophy and footer`

---

## Task 7: Scroll companion mascot

**Files:** modify `index.html`, `mascot.css`, `app.js`

- [x] **Step 1: Add a fixed companion face** near the end of `<body>`:

```html
<div class="companion" aria-hidden="true">
  <span class="mdl sm c-recon track" id="compFace">
    <span class="eyes"><i class="eye left"></i><i class="eye right"></i></span>
  </span>
</div>
```

- [x] **Step 2: State mapper + scroll observer in `app.js`** (replaces the Task 4
  stub):

```js
var STATES = ["track", "think", "read", "find", "run", "edit", "web", "done", "error"];
var SECTION_STATE = { why: "think", start: "run", features: "read", frontends: "web", serve: "run" };
function setFaceState(state) {
  var f = document.getElementById("compFace");
  if (!f) return;
  STATES.forEach(function (s) { f.classList.remove("st-" + s); });
  f.classList.add("st-" + (state || "track"));
}
var io = new IntersectionObserver(function (entries) {
  entries.forEach(function (e) {
    if (e.isIntersecting) setFaceState(SECTION_STATE[e.target.id] || "track");
  });
}, { rootMargin: "-45% 0px -45% 0px" });
["why", "start", "features", "frontends", "serve"].forEach(function (id) {
  var el = document.getElementById(id);
  if (el) io.observe(el);
});
```

On reaching the footer set `done`.

- [x] **Step 3: Reduced motion** — if
  `matchMedia("(prefers-reduced-motion: reduce)").matches`, do not observe;
  set `done` once and hide the companion (or keep it static).

- [x] **Step 4: Verify** scrolling changes the companion state per section;
  hovering a capability card overrides it and returns to `track` on leave.

- [x] **Step 5: Commit** `feat(landing): scroll companion mascot`

---

## Task 8: Favicon, responsive polish, docs

**Files:** create `gh-pages/favicon.svg`; modify `styles.css`, `AGENTS.md`, `CHANGELOG.md`

- [x] **Step 1: `favicon.svg`** — squircle + two eyes, accent gradient.

- [x] **Step 2: Responsive + polish** — nav collapses its section links below
  760px (keep brand + toggles); hero stacks (face above text); `.cards` and
  `.two` go single column; confirm horizontal scroll is absent at 390px.

- [x] **Step 3: `AGENTS.md`** — add a short "Landing Page (`gh-pages/`)" section:
  what it is, that it is build-free, that Pages source is `master` `/gh-pages`.

- [x] **Step 4: `CHANGELOG.md`** — `### Added` entry for the landing page.

- [x] **Step 5: Commit** `feat(landing): favicon, responsive polish, docs`

---

## Task 9: Verification

**Files:** none (verification only)

- [x] **Step 1: Browser matrix** — dark/light × ru/en at 1440px and 390px; check
  no console errors, no horizontal scroll, copy button works, links resolve.
- [x] **Step 2: Reduced motion** — emulate `prefers-reduced-motion: reduce`;
  confirm no marquee/scroll animation and a static final face.
- [x] **Step 3: Offline / `file://`** — open `gh-pages/index.html` directly;
  confirm it renders (no fetch, no absolute paths).
- [x] **Step 4: Quality gate untouched**

Run: `bun run quality`
Expected: exit 0 (the `gh-pages/` folder is outside `src/`, so it is not
linted/typechecked).

- [x] **Step 5: Smoke test (optional)**

Run: `bun test tests/landing-page.test.ts`
Expected: PASS — asserts `gh-pages/index.html` exists, links
`styles.css`/`app.js`/`i18n.js`, and `i18n.js` defines both `ru` and `en`.

---

## Self-Review notes

- **Spec coverage:** Goal/audience → Tasks 1–8 content; files → Task 1;
  i18n → Tasks 1,3–6; theming → Tasks 1–2; mascot hero/cursor → Task 2;
  mascot scroll companion + capability hover → Tasks 4,7; structure sections
  1–9 → Tasks 2–6; STYLE glyphs → Task 5; publication/AGENTS/CHANGELOG →
  Task 8; verification → Task 9. No gaps.
- **Type consistency:** `applyI18n`, `setLang`, `setTheme`, `initFace`,
  `setFaceState`, `STATES`, `SECTION_STATE` are defined once (Tasks 1,2,7) and
  reused consistently. `setFaceState` is stubbed in Task 4 and finalized in
  Task 7.
- **Placeholders:** copy keys are enumerated per task; content is drawn from the
  spec and `docs/mma-features-overview.md`. No "TBD".
