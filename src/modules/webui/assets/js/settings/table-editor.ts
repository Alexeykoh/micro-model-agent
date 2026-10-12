// Record editor (`json` table) — вынесено из `editors.ts` (правило ≤300).
// Rows are held locally and the whole record is validated client-side before
// posting, so a half-filled new row never round-trips to the server. Nothing is
// posted until the record satisfies the required columns.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import type { Dict } from "../core/store/types.js";

interface TableRow {
  name: string;
  val: Dict;
  error: string;
}

interface BuildResult {
  ok: boolean;
  reason?: string;
  value?: Dict;
}

/** Record editor: one row per key, typed columns, add/remove. */
export function tableEditor(value: unknown, ctx: Dict, editor: Dict): HTMLElement {
  const columns: Dict[] = editor.columns || [];
  const keyCol = columns[0];
  const rest = columns.slice(1);
  const source: Dict =
    value && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : {};
  const rows: TableRow[] = Object.entries(source).map(([name, val]) => ({
    name,
    val: val && typeof val === "object" ? { ...(val as Dict) } : {},
    error: "",
  }));
  const wrap = el("div", "tablectl ctl-block");
  const head = el("div", "table-head");
  columns.forEach((c) => head.appendChild(el("span", "table-th", ctx.fieldLabel(c.key))));
  wrap.appendChild(head);
  const body = el("div", "table-body");
  const error = el("div", "json-err");
  error.hidden = true;

  const colIsArray = (col: Dict) => col.array === true;
  const isBlank = (v: unknown) =>
    v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

  /** Build the record; empty optional values are dropped. Returns null + reason. */
  const build = (): BuildResult => {
    const out: Dict = {};
    for (const row of rows) {
      if (!row.name) return { ok: false, reason: "empty name" };
      if (out[row.name] !== undefined) return { ok: false, reason: `duplicate: ${row.name}` };
      const entry: Dict = {};
      for (const col of rest) {
        const v = row.val[col.key];
        if (col.optional && isBlank(v)) continue;
        if (!col.optional && isBlank(v))
          return { ok: false, reason: `${row.name}: ${ctx.fieldLabel(col.key)}` };
        if (col.type === "number") {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0)
            return { ok: false, reason: `${row.name}: ${ctx.fieldLabel(col.key)}` };
          entry[col.key] = n;
        } else if (col.type === "bool") {
          if (v === true) entry[col.key] = true;
        } else {
          entry[col.key] = colIsArray(col) ? v : String(v);
        }
      }
      out[row.name] = entry;
    }
    return { ok: true, value: out };
  };

  const sync = () => {
    const built = build();
    if (!built.ok) {
      error.hidden = false;
      error.textContent = t("web.settings.table_invalid", { field: built.reason || "" });
      return false;
    }
    error.hidden = true;
    error.textContent = "";
    ctx.post(JSON.stringify(built.value));
    return true;
  };

  const writeValue = (row: TableRow, col: Dict, input: HTMLInputElement) => {
    if (col.type === "bool") {
      if (input.checked) row.val[col.key] = true;
      else delete row.val[col.key];
    } else if (col.type === "number") {
      const raw = input.value.trim();
      if (raw === "") delete row.val[col.key];
      else row.val[col.key] = Number(raw);
    } else {
      const raw = input.value.trim();
      if (raw === "") delete row.val[col.key];
      else
        row.val[col.key] = colIsArray(col)
          ? raw.split(",").map((s) => s.trim()).filter(Boolean)
          : raw;
    }
  };

  const inputFor = (row: TableRow, col: Dict): HTMLInputElement | HTMLSelectElement => {
    const v = row.val[col.key];
    // Column whose value is a reference to a live list (models/providers):
    // render a dropdown so the user picks an id instead of typing it.
    if (col.optionsSource) {
      const source = col.optionsSource;
      const opts: string[] =
        source === "providers" ? ctx.providerOptions || [] : ctx.modelOptions || [];
      const cur = v == null ? "" : String(v);
      const sel = el("select");
      const none = el("option", "", "—");
      none.value = "";
      sel.appendChild(none);
      const seen = new Set([""]);
      opts.forEach((o: string) => {
        if (seen.has(o)) return;
        seen.add(o);
        const op = el("option", "", o);
        op.value = o;
        if (o === cur) op.selected = true;
        sel.appendChild(op);
      });
      if (cur && !seen.has(cur)) {
        const op = el("option", "", cur);
        op.value = cur;
        op.selected = true;
        sel.appendChild(op);
      }
      sel.value = cur || "";
      sel.setAttribute("aria-label", `${row.name}: ${ctx.fieldLabel(col.key)}`);
      sel.addEventListener("change", () => {
        if (sel.value) row.val[col.key] = sel.value;
        else delete row.val[col.key];
        sync();
      });
      return sel;
    }
    const input = el("input");
    if (col.type === "bool") {
      input.type = "checkbox";
      input.checked = v === true;
    } else if (col.type === "number") {
      input.type = "number";
      input.value = v == null ? "" : String(v);
    } else {
      input.type = "text";
      input.value = Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v);
    }
    input.setAttribute("aria-label", `${row.name}: ${ctx.fieldLabel(col.key)}`);
    input.addEventListener("change", () => {
      writeValue(row, col, input);
      sync();
    });
    return input;
  };

  const draw = () => {
    body.textContent = "";
    rows.forEach((row) => {
      const elRow = el("div", "table-row");
      elRow.dataset.key = row.name;
      const keyInput = el("input");
      keyInput.type = "text";
      keyInput.value = row.name;
      keyInput.placeholder = ctx.fieldLabel(keyCol.key);
      keyInput.setAttribute("aria-label", ctx.fieldLabel(keyCol.key));
      keyInput.addEventListener("change", () => {
        row.name = keyInput.value.trim();
        if (sync()) {
          elRow.dataset.key = row.name;
        }
      });
      elRow.appendChild(keyInput);
      rest.forEach((col) => elRow.appendChild(inputFor(row, col)));
      const rm = el("button", "table-rm linkbtn", "✕");
      rm.type = "button";
      rm.setAttribute("aria-label", `${ctx.label}: remove ${row.name}`);
      rm.addEventListener("click", () => {
        rows.splice(rows.indexOf(row), 1);
        if (sync()) draw();
      });
      elRow.appendChild(rm);
      body.appendChild(elRow);
    });
  };
  draw();
  wrap.appendChild(body);
  wrap.appendChild(error);

  const adder = el("div", "table-add");
  const nameInput = el("input");
  nameInput.type = "text";
  nameInput.placeholder = ctx.fieldLabel(keyCol.key);
  nameInput.setAttribute("aria-label", `${ctx.label}: new ${ctx.fieldLabel(keyCol.key)}`);
  // A new row is local until it satisfies the required columns — no POST yet.
  const submit = () => {
    const name = nameInput.value.trim();
    if (!name || rows.some((r) => r.name === name)) {
      nameInput.select();
      return;
    }
    const seed: Dict = {};
    rows.push({ name, val: seed, error: "" });
    nameInput.value = "";
    draw();
    const last = body.lastElementChild;
    const first = last && last.querySelectorAll<HTMLElement>("input,select")[1];
    if (first) first.focus();
  };
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  });
  adder.appendChild(nameInput);
  const plus = el("button", "table-plus linkbtn", "+");
  plus.type = "button";
  plus.setAttribute("aria-label", `${ctx.label}: add`);
  plus.addEventListener("click", submit);
  adder.appendChild(plus);
  wrap.appendChild(adder);
  return wrap;
}
