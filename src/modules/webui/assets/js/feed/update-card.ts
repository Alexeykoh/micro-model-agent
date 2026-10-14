// Feed "update available" card for the empty state: version, install button and
// a dismiss ✕. Extracted from `feed/core.ts` (file-size rule 6).
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { api } from "../api.js";
import { createFace } from "../loader.js";
import { setIndicator } from "../dialog.js";
import { dismissUpdate, type UpdateInfo } from "../update-state.js";

export function updateCard(upd: UpdateInfo): HTMLElement {
  const card = el("div", "upd-card");
  card.appendChild(createFace("load", "sm"));
  const body = el("div", "upd-body");
  body.appendChild(el("div", "upd-t", t("web.update.card_title", { latest: upd.latest })));
  body.appendChild(el("div", "upd-s", t("web.update.card_sub", { current: upd.current })));
  const btn = el("button", "upd-btn", t("web.update.install"));
  btn.type = "button";
  btn.addEventListener("click", () => void runUpdate(btn));
  body.appendChild(btn);
  card.appendChild(body);
  const close = el("button", "upd-x", "✕");
  close.type = "button";
  close.title = t("web.update.dismiss");
  close.setAttribute("aria-label", t("web.update.dismiss"));
  close.addEventListener("click", () => {
    dismissUpdate();
    card.remove();
  });
  card.appendChild(close);
  return card;
}

// POST the install to the server; report the outcome via the shared toast. The
// live progress/button updates arrive over SSE (`update` → `app.ts`).
async function runUpdate(btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = t("web.update.installing");
  const r = await api<{ ok?: boolean; installed?: string; error?: string }>("/api/update", {
    method: "POST",
    body: {},
  });
  if (r.ok && r.data && r.data.ok) {
    setIndicator(t("web.update.installed", { latest: r.data.installed || "" }), false);
  } else {
    setIndicator((r.data && r.data.error) || t("web.update.failed"), true);
    btn.disabled = false;
    btn.textContent = t("web.update.install");
  }
}
