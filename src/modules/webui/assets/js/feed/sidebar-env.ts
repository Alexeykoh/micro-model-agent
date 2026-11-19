// Environment (sidebar): stacked name/value items — AGENTS.md sources, map size.
// Extracted from `feed/sidebar.ts` (правило 6: файл у потолка 300).
import { el, envEl } from "../dom.js";
import { I18N, t, pluralCount } from "../i18n.js";
import { feed } from "../store.js";
import type { Dict } from "../core/store/types.js";

// Environment (sidebar): stacked name/value items — AGENTS.md sources, map size.
function envItem(label: string, values: string[]): HTMLElement {
  const item = el("div", "env-item");
  item.appendChild(el("div", "env-k", label));
  values.forEach((val) => {
    const v = el("div", "env-v", val);
    v.title = val;
    item.appendChild(v);
  });
  return item;
}

export function renderEnvironment(h: Dict): void {
  const disabled = !!(h.instructions && h.instructions.disabled);
  const files = h.instructions && !disabled ? h.instructions.files || [] : [];
  const map = h.projectMap || null;
  const sig = JSON.stringify([disabled, files, map, I18N.locale]);
  if (sig === feed.lastEnvSig) return;
  feed.lastEnvSig = sig;
  envEl.textContent = "";
  envEl.appendChild(
    envItem(
      t("web.env.agents"),
      disabled ? [t("web.env.agents_disabled")] : files.length ? files : [t("web.env.agents_none")],
    ),
  );
  envEl.appendChild(
    envItem(
      t("web.env.map"),
      map && map.indexed
        ? [
            [
              pluralCount("web.env.files", map.files),
              pluralCount("web.env.symbols", map.symbols),
              pluralCount("web.env.tokens", map.tokens),
            ].join(" · "),
          ]
        : [t("web.env.map_not_indexed")],
    ),
  );
}
