// Компактный набор вкладок сайдбара (`mma web`): видимыми остаются приоритетные
// вкладки (Сессия · Файлы · Изменения · Субагенты), остальные свёрнуты за
// кнопкой-стрелкой. Клик по стрелке «вправо» раскрывает все вкладки и
// переворачивает её «влево»; повторный клик скрывает раскрытое (TODO §1.13).
//
// Лист-модуль: не импортирует core/files — ядро лишь вызывает init и передаёт
// корень `.sb`; граф фронтенда остаётся ацикличным.
import { icon } from "../dom.js";
import { t } from "../i18n.js";

/** Вкладки, всегда видимые в компактном режиме. */
export const PRIORITY_TABS: readonly string[] = ["session", "files", "git", "subagents"];

/** Класс, прячущий вкладку (возврат = natural display, без хардкода layout). */
const HIDDEN = "sb-hidden";

let btn: HTMLButtonElement | null = null;
let bar: HTMLElement | null = null;
let extras: HTMLElement[] = [];
let expanded = false;

function paint(): void {
  if (!btn) return;
  // Раскрытый набор — другой порог подписей в CSS (container query читает
  // `.sb-expanded`): десять вкладок с текстом не вмещаются почти никогда.
  if (bar) bar.classList.toggle("sb-expanded", expanded);
  for (const tab of extras) tab.classList.toggle(HIDDEN, !expanded);
  // Иконка двусторонняя: «вправо» — свернуто (нажми, чтоб раскрыть),
  // «влево» — раскрыто (нажми, чтоб свернуть).
  btn.textContent = "";
  btn.appendChild(icon(expanded ? "chevron-left" : "chevron-right"));
  btn.setAttribute("aria-expanded", String(expanded));
}

/**
 * Строит кнопку-переключатель и прячет не-приоритетные вкладки. Если активная
 * вкладка — из свёрнутых (запомненный stored tab), панель сразу раскрыта.
 */
export function initCompactTabs(root: HTMLElement): void {
  bar = root.querySelector<HTMLElement>(".sb-tabs");
  if (!bar || btn) return;
  extras = Array.from(root.querySelectorAll<HTMLElement>(".sb-tab")).filter(
    (tab) => !PRIORITY_TABS.includes(tab.dataset.tab || "session"),
  );
  if (extras.length === 0) return;

  expanded = extras.some((tab) => tab.classList.contains("on"));

  btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sb-tab-toggle";
  btn.setAttribute("aria-label", t("web.sidebar.more"));
  btn.addEventListener("click", () => {
    expanded = !expanded;
    paint();
  });

  // Вставка до кнопки настроек (в конце полосы): вкладки → стрелка → настройки.
  const settings = bar.querySelector(".sb-settings");
  if (settings) bar.insertBefore(btn, settings);
  else bar.appendChild(btn);

  paint();
}

/**
 * Реакция на смену активной вкладки: если она из свёрнутых (Alt+N, стрелки),
 * раскрываем, чтобы не остаться на активном, но невидимом бейдже.
 */
export function syncCompactActive(activeTab: string): void {
  if (!btn) return;
  if (!expanded && extras.some((tab) => tab.dataset.tab === activeTab)) {
    expanded = true;
    paint();
  }
}
