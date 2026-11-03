/** DOM-примитивы визарда: элементы, поля, шаг-заголовок и строка сообщения. */
import { tr } from "./setup-i18n.js";

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string | null,
  text?: string | number | null,
): HTMLElementTagNameMap[K];
export function h(tag: string, cls?: string | null, text?: string | number | null): HTMLElement;
export function h(tag: string, cls?: string | null, text?: string | number | null): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = String(text);
  return node;
}

export function stepBody(name: string): HTMLElement {
  const box = h("div", "setup-step");
  box.appendChild(h("h2", "setup-step-title", tr("web.setup." + name + ".title")));
  const hint = tr("web.setup." + name + ".hint");
  if (hint !== "web.setup." + name + ".hint") box.appendChild(h("p", "setup-hint", hint));
  return box;
}

export function field(label: string, input: HTMLElement): HTMLElement {
  const box = h("div", "setup-field");
  box.appendChild(h("label", "setup-label", label));
  box.appendChild(input);
  return box;
}

export function inputEl(
  value: string | number,
  type?: string,
  placeholder?: string,
): HTMLInputElement {
  const input = h("input", "setup-input");
  input.type = type || "text";
  input.value = String(value || "");
  if (placeholder) input.placeholder = placeholder;
  input.addEventListener("input", () => {
    msg = null;
  });
  return input;
}

let msg: { kind: string; text: string } | null = null;

/** Снимает текущее сообщение шага (переход/навигация начинают с чистого листа). */
export function clearMsg(): void {
  msg = null;
}

export function messageEl(): HTMLElement {
  const el = h("div", "setup-msg");
  if (msg) {
    el.className = "setup-msg " + msg.kind;
    el.textContent = msg.text;
  }
  return el;
}

export function setMsg(box: Element | null, kind: string, text: string): void {
  msg = { kind, text };
  const el = box ? box.querySelector(".setup-msg") : null;
  if (!el) return;
  el.className = "setup-msg " + kind;
  el.textContent = "";
  if (kind === "" && text) {
    // Loading states (test/scan/test-model) show the agent face.
    const face = h("span", "mdl sm st-think");
    face.setAttribute("aria-hidden", "true");
    face.appendChild(h("span", "eyes"));
    const eyes = face.firstElementChild as HTMLElement;
    eyes.appendChild(h("i", "eye left"));
    eyes.appendChild(h("i", "eye right"));
    el.appendChild(face);
    el.appendChild(document.createTextNode(" " + text));
  } else {
    el.textContent = text;
  }
}
