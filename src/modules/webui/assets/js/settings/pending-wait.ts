// A5 (INV-W8, спека 2026-11-04-webui-latency-design): время ожидания
// переключателя провайдера/модели. Статичный `⋯` не отвечает на вопрос
// «зависло или ещё работает» — через секунду на кнопке появляется счётчик.
//
// `settings/write.ts` владеет флагом pending и закреплён за параллельной
// волной B, поэтому индикатор читает DOM (появление класса `pending`),
// а не состояние воронки записи.
const TICK_MS = 500;
/** Счётчик показывается после этой паузы (мс): до неё хватает спиннера. */
export const WAIT_SHOW_AFTER_MS = 1_000;

let observer: MutationObserver | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let startedAt = 0;

function pendingButtons(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".sel > button.pending"));
}

/**
 * Перерисовать счётчик по текущему DOM. Экспортируется, чтобы тесты могли
 * вызвать её вручную, не дожидаясь интервала.
 */
export function paintPendingWait(): void {
  const buttons = pendingButtons();
  if (!buttons.length) {
    startedAt = 0;
    // Запись закончилась — снимаем счётчик даже с уже не-pending подписей.
    for (const stale of document.querySelectorAll<HTMLElement>("[data-wait]")) {
      delete stale.dataset.wait;
    }
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    return;
  }
  if (!startedAt) startedAt = Date.now();
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  for (const btn of buttons) {
    // `content: attr(...)` читает атрибут с элемента, у которого `::after`,
    // — то есть с подписи `b`, а не с кнопки.
    const label = btn.querySelector<HTMLElement>("b") ?? btn;
    if (elapsed * 1000 >= WAIT_SHOW_AFTER_MS) label.dataset.wait = `${elapsed}s`;
    else delete label.dataset.wait;
  }
  if (!timer) timer = setInterval(paintPendingWait, TICK_MS);
}

/**
 * Начать следить за индикатором записи. Идемпотентно; вызывается один раз
 * при загрузке модуля селекторов.
 */
export function initPendingWait(): void {
  const root = document.querySelector(".selectors");
  if (!root) return;
  if (typeof MutationObserver !== "function") {
    // Наблюдателя нет (старый браузер, тестовое окружение) — таймер и так
    // подхватит появление `pending`.
    paintPendingWait();
    return;
  }
  if (!observer) {
    observer = new MutationObserver(() => paintPendingWait());
    observer.observe(root, { attributes: true, subtree: true, attributeFilter: ["class"] });
  }
  paintPendingWait();
}
