// INV-W8 (спека 2026-11-04-webui-latency-design, A1): переключение вкладки
// блокирует ровно тот ввод, чьи данные ещё не пришли. Один переключатель на
// весь экран: composer (`readOnly` + disabled кнопки) и лента (`aria-busy`) —
// без отдельного флага в каждом хендлере.
import { inp, msgs, sendBtn } from "../dom.js";

let switching = false;

/** Включить/выключить блокировку ввода на время переключения вкладки. */
export function setSwitching(on: boolean): void {
  if (switching === on) return;
  switching = on;
  if (inp) {
    // `readOnly`, а не `disabled`: фокус и позиция курсора сохраняются, а ввод
    // в ещё не активированную сессию исключён.
    inp.readOnly = on;
    inp.dataset.switching = on ? "true" : "false";
  }
  // `disabled` у button, а у `sendBtn` в типах объявлен `HTMLElement` —
  // через атрибут, как это делают остальные хендлеры.
  if (sendBtn) {
    if (on) sendBtn.setAttribute("disabled", "disabled");
    else sendBtn.removeAttribute("disabled");
  }
  document.querySelector(".input-area")?.classList.toggle("switching", on);
  if (on) msgs?.setAttribute("aria-busy", "true");
  else msgs?.removeAttribute("aria-busy");
}

/** Идёт ли сейчас переключение (для тестов и диагностики). */
export function isSwitching(): boolean {
  return switching;
}
