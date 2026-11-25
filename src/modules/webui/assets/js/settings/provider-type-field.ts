// Provider-type picker used by the add/edit dialog. A native <select> cannot
// show brand icons in its option list, so this is a small accessible listbox
// with the same `value` / `input` / `change` surface as `<select>`.
import { el, icon } from "../dom.js";
import { providerIcon } from "./provider-icons.js";

/** Minimal `<select>` surface needed by the preset-sync wiring. */
export interface TypeControl {
  value: string;
  addEventListener(ev: string, fn: EventListenerOrEventListenerObject): void;
  setAttribute(k: string, v: string): void;
}

export interface ProviderTypeField extends TypeControl {
  node: HTMLElement;
}

export function providerTypeField(
  options: string[],
  value: string | null | undefined,
): ProviderTypeField {
  const values = ["", ...options];
  const initial = value == null ? "" : String(value);
  if (initial && !values.includes(initial)) values.push(initial);
  let current = initial;

  const node = el("div", "ptype");
  const btn = el("button", "ptype-btn");
  btn.type = "button";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  const menu = el("div", "ptype-menu");
  menu.setAttribute("role", "listbox");
  menu.hidden = true;

  const paintButton = (): void => {
    const mark = current ? providerIcon(current) : icon("plug");
    btn.replaceChildren(mark, el("span", "ptype-val", current || "—"), icon("chevron-down"));
    btn.title = current || "—";
  };
  const paintOptions = (): void => {
    opts.forEach((o) => o.setAttribute("aria-selected", o.dataset.value === current ? "true" : "false"));
  };
  const close = (): void => {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  };
  const open = (): void => {
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
  };
  const select = (v: string): void => {
    current = v;
    paintButton();
    paintOptions();
    close();
    btn.focus();
    btn.dispatchEvent(new Event("input", { bubbles: true }));
    btn.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const opts = values.map((v) => {
    const o = el("button", "ptype-opt");
    o.type = "button";
    o.dataset.value = v;
    o.setAttribute("role", "option");
    o.setAttribute("aria-selected", "false");
    o.appendChild(v ? providerIcon(v) : icon("plug"));
    o.appendChild(el("span", "ptype-opt-label", v || "—"));
    o.addEventListener("click", () => select(v));
    return o;
  });
  opts.forEach((o, i) => {
    o.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        const step = ev.key === "ArrowDown" ? 1 : -1;
        opts[(i + step + opts.length) % opts.length].focus();
      } else if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        select(o.dataset.value || "");
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        close();
        btn.focus();
      } else if (ev.key === "Tab") {
        close();
      }
    });
  });

  btn.addEventListener("click", () => (menu.hidden ? open() : close()));
  btn.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      open();
      opts[ev.key === "ArrowDown" ? 0 : opts.length - 1].focus();
    } else if (ev.key === "Escape") {
      close();
    }
  });
  node.addEventListener("focusout", (ev) => {
    if (!node.contains(ev.relatedTarget as Node | null)) close();
  });

  paintButton();
  paintOptions();
  menu.append(...opts);
  node.append(btn, menu);

  return {
    node,
    get value() {
      return current;
    },
    set value(v: string) {
      current = v == null ? "" : String(v);
      paintButton();
      paintOptions();
    },
    addEventListener: (ev, fn) => btn.addEventListener(ev, fn),
    setAttribute: (k, v) => btn.setAttribute(k, v),
  };
}
