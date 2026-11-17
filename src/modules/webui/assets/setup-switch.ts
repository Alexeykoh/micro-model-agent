/** Переключатели визарда в том же виде, что и в настройках: button.toggle. */
import { h } from "./setup-dom.js";

/** Кнопка-переключатель (`role="switch"`), как `makeToggle` в settings. */
export function switchEl(on: boolean, onChange: (next: boolean) => void): HTMLButtonElement {
  const btn = h("button", "toggle" + (on ? " on" : ""));
  btn.type = "button";
  btn.setAttribute("role", "switch");
  btn.setAttribute("aria-checked", String(on));
  btn.addEventListener("click", () => {
    const next = !btn.classList.contains("on");
    btn.classList.toggle("on", next);
    btn.setAttribute("aria-checked", String(next));
    onChange(next);
  });
  return btn;
}

/** Строка «переключатель + название + пояснение». */
export function toggleRow(
  on: boolean,
  label: string,
  desc: string,
  onChange: (next: boolean) => void,
): HTMLElement {
  const row = h("div", "setup-toggle");
  const sw = switchEl(on, onChange);
  const texts = h("span", "setup-toggle-texts");
  texts.appendChild(h("span", "t", label));
  if (desc) texts.appendChild(h("span", "d", desc));
  texts.addEventListener("click", () => sw.click());
  row.appendChild(sw);
  row.appendChild(texts);
  return row;
}
