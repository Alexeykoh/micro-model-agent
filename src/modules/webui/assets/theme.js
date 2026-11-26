// Bootstrap темы и hard-failsafe сплэша. Вынесено из index.html: CSP веба
// разрешает только внешние скрипты с того же origin (script-src 'self').

(function () {
  // Это только кэш-зеркало серверного конфига (`ui.theme`/`ui.themeMode`):
  // авторитетное значение приходит через GET /api/config и применяется app.js.
  try {
    var theme = localStorage.getItem("mma-theme") || "auto";
    var light = theme === "light" ||
      (theme === "auto" && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
    if (light) document.body.classList.add("light");
    // Сообщаем браузеру схему и цвет хрома до первой отрисовки — иначе нативные
    // скроллбары и адресная строка остаются светлыми.
    document.documentElement.style.colorScheme = light ? "light" : "dark";
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", light ? "#f7f7f4" : "#0f0f10");
    var locale = localStorage.getItem("mma-locale");
    if (locale === "en" || locale === "ru") document.documentElement.lang = locale;
    var ui = localStorage.getItem("mma-ui-theme") || "console";
    var uiThemes = ["console", "groovebox", "neon", "paper", "contrast", "winter", "spring", "summer", "autumn", "metallica", "omarchy"];
    if (uiThemes.indexOf(ui) >= 0) document.body.classList.add(ui);
  } catch (e) { /* ignore */ }
})();

// Модуль может упасть или задержать импорт — сплэш не должен блокировать страницу
// навсегда. 12 с: живой boot продолжает счётчик stages (A3), но без app.js сплэш
// всё равно уходит сам.
window.setTimeout(function () {
  var s = document.getElementById("bootSplash");
  if (!s || s.hidden) return;
  s.classList.add("hide");
  window.setTimeout(function () { s.hidden = true; }, 500);
}, 12000);
