// Structured editors for `list`/`json` settings keys (`settings/controls.js`).
// Each posts a JSON string; `parseConfigValue` accepts a JSON array for `list`
// and JSON.parse for `json`, so values containing commas (regexes, tags) survive.
// Never uses innerHTML — all user or config data goes through `textContent`.
import { el } from "../dom.js";
import { t } from "../i18n.js";

/** String chips with per-item remove and an inline "add" field. */
export function tagsEditor(value, ctx, editor) {
  const items = Array.isArray(value) ? value.map(String) : [];
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
export function checkboxEditor(value, ctx, editor) {
  const selected = new Set(Array.isArray(value) ? value.map(String) : []);
  const wrap = el("div", "checksctl ctl-block");
  (editor.options || []).forEach((opt) => {
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

/** Record editor: one row per key, typed columns, add/remove.
 *
 * Rows are held locally and the whole record is validated client-side before
 * posting, so a half-filled new row never round-trips to the server (which
 * would reject the object with a generic "invalid"). Nothing is posted until
 * the record satisfies the required columns. */
export function tableEditor(value, ctx, editor) {
  const columns = editor.columns || [];
  const keyCol = columns[0];
  const rest = columns.slice(1);
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const rows = Object.entries(source).map(([name, val]) => ({
    name,
    val: val && typeof val === "object" ? { ...val } : {},
    error: "",
  }));
  const wrap = el("div", "tablectl ctl-block");
  const head = el("div", "table-head");
  columns.forEach((c) => head.appendChild(el("span", "table-th", ctx.fieldLabel(c.key))));
  wrap.appendChild(head);
  const body = el("div", "table-body");
  const error = el("div", "json-err");
  error.hidden = true;

  const colIsArray = (col) => col.array === true;
  const isBlank = (v) => v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

  /** Build the record; empty optional values are dropped. Returns null + reason. */
  const build = () => {
    const out = {};
    for (const row of rows) {
      if (!row.name) return { ok: false, reason: "empty name" };
      if (out[row.name] !== undefined) return { ok: false, reason: `duplicate: ${row.name}` };
      const entry = {};
      for (const col of rest) {
        const v = row.val[col.key];
        if (col.optional && isBlank(v)) continue;
        if (!col.optional && isBlank(v)) return { ok: false, reason: `${row.name}: ${ctx.fieldLabel(col.key)}` };
        if (col.type === "number") {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0) return { ok: false, reason: `${row.name}: ${ctx.fieldLabel(col.key)}` };
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
      error.textContent = t("web.settings.table_invalid", { field: built.reason });
      return false;
    }
    error.hidden = true;
    error.textContent = "";
    ctx.post(JSON.stringify(built.value));
    return true;
  };

  const writeValue = (row, col, input) => {
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
      else row.val[col.key] = colIsArray(col) ? raw.split(",").map((s) => s.trim()).filter(Boolean) : raw;
    }
  };

  const inputFor = (row, col) => {
    const input = el("input");
    const v = row.val[col.key];
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
    const seed = {};
    rows.push({ name, val: seed, error: "" });
    nameInput.value = "";
    draw();
    const last = body.lastElementChild;
    const first = last && last.querySelectorAll("input")[1];
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
