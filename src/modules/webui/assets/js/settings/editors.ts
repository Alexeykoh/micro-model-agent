// Structured editors for `list`/`json` settings keys (`settings/controls.js`).
// Each posts a JSON string; `parseConfigValue` accepts a JSON array for `list`
// and JSON.parse for `json`, so values containing commas (regexes, tags) survive.
// Never uses innerHTML — all user or config data goes through `textContent`.
import { el } from "../dom.js";
import type { Dict } from "../core/store/types.js";

/** String chips with per-item remove and an inline "add" field. */
export function tagsEditor(value: unknown, ctx: Dict, editor: Dict): HTMLElement {
  const items: string[] = Array.isArray(value) ? value.map(String) : [];
  const wrap = el("div", "tagsctl ctl-block");
  const list = el("div", "tags-list");
  const commit = () => ctx.post(JSON.stringify(items));
  const draw = () => {
    list.textContent = "";
    items.forEach((tag, i) => {
      const chip = el("span", "tag-chip");
      const text = el("span", "tag-text", tag);
      text.title = tag;
      chip.appendChild(text);
      const rm = el("button", "tag-rm linkbtn", "✕");
      rm.type = "button";
      rm.setAttribute("aria-label", `${ctx.label}: remove ${tag}`);
      rm.addEventListener("click", () => {
        items.splice(i, 1);
        commit();
        draw();
      });
      chip.appendChild(rm);
      list.appendChild(chip);
    });
    if (!items.length) list.appendChild(el("span", "tags-empty", ctx.emptyLabel || "—"));
  };
  draw();
  wrap.appendChild(list);
  const adder = el("div", "tags-add");
  const inp = el("input");
  inp.type = "text";
  inp.placeholder = editor.placeholder || "…";
  inp.setAttribute("aria-label", ctx.label);
  const submit = () => {
    const v = inp.value.trim();
    if (!v || items.includes(v)) {
      inp.select();
      return;
    }
    items.push(v);
    commit();
    draw();
    inp.value = "";
    inp.focus();
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  });
  adder.appendChild(inp);
  const plus = el("button", "tags-plus linkbtn", "+");
  plus.type = "button";
  plus.setAttribute("aria-label", `${ctx.label}: add`);
  plus.addEventListener("click", submit);
  adder.appendChild(plus);
  wrap.appendChild(adder);
  return wrap;
}

/** Multiselect over a fixed option list (an empty selection = all). */
export function checkboxEditor(value: unknown, ctx: Dict, editor: Dict): HTMLElement {
  const selected = new Set<string>(Array.isArray(value) ? value.map(String) : []);
  const wrap = el("div", "checksctl ctl-block");
  (editor.options || []).forEach((opt: string) => {
    const label = el("label", "check-line");
    const box = el("input");
    box.type = "checkbox";
    box.checked = selected.has(opt);
    box.addEventListener("change", () => {
      if (box.checked) selected.add(opt);
      else selected.delete(opt);
      ctx.post(JSON.stringify([...selected]));
    });
    label.appendChild(box);
    label.appendChild(el("span", "", ctx.enumLabel ? ctx.enumLabel(opt) : opt));
    wrap.appendChild(label);
  });
  return wrap;
}

/** Record editor exported from `./table-editor`; re-exported for existing importers. */
export { tableEditor } from "./table-editor.js";
