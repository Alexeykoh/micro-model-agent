/** Шаг Security: строки-переключатели и поп-апы тонкой настройки. */
import type { SetupContext } from "./setup-context.js";
import { h, stepBody } from "./setup-dom.js";
import { tr } from "./setup-i18n.js";
import {
  GROUP_KEYS,
  SECURITY_POPUPS,
  popupField,
  setPath,
} from "./setup-security-fields.js";
import type { Dict } from "./setup-state.js";

export function renderSecurity(ctx: SetupContext): HTMLElement {
  const box = stepBody("security");
  const toggles: Array<[string, string, string, string]> = [
    ["securityPathsRestrict", "web.setup.security.paths", "web.setup.security.paths_desc", "paths"],
    ["securityBashBlock", "web.setup.security.bash", "web.setup.security.bash_desc", "bash"],
    ["securityFlagsBlock", "web.setup.security.flags", "web.setup.security.flags_desc", "flags"],
  ];
  toggles.forEach(([key, labelKey, descKey, group]) => {
    const row = h("div", "setup-sec-row");
    const label = h("label", "setup-toggle");
    const cb = h("input");
    cb.type = "checkbox";
    cb.checked = Boolean(ctx.state.answers[key]);
    cb.addEventListener("change", () => {
      ctx.state.answers[key] = cb.checked;
    });
    label.appendChild(cb);
    const texts = h("span", "setup-toggle-texts");
    texts.appendChild(h("span", "t", tr(labelKey)));
    const desc = tr(descKey);
    if (desc !== descKey) texts.appendChild(h("span", "d", desc));
    label.appendChild(texts);
    row.appendChild(label);
    row.appendChild(detailButton(ctx, group, tr(labelKey)));
    box.appendChild(row);
  });

  // Звуки уведомлений веб-UI: отдельный тумблер без тонкой настройки.
  const soundRow = h("div", "setup-sec-row");
  const soundLabel = h("label", "setup-toggle");
  const soundCb = h("input");
  soundCb.type = "checkbox";
  soundCb.checked = Boolean(ctx.state.answers.soundsEnabled);
  soundCb.addEventListener("change", () => {
    ctx.state.answers.soundsEnabled = soundCb.checked;
  });
  soundLabel.appendChild(soundCb);
  const soundTexts = h("span", "setup-toggle-texts");
  soundTexts.appendChild(h("span", "t", tr("web.setup.security.sounds")));
  soundTexts.appendChild(h("span", "d", tr("web.setup.security.sounds_desc")));
  soundLabel.appendChild(soundTexts);
  soundRow.appendChild(soundLabel);
  box.appendChild(soundRow);

  const advRow = h("div", "setup-sec-row");
  const advTexts = h("span", "setup-toggle setup-adv-label");
  advTexts.appendChild(h("span", "t", tr("web.setup.security.advanced")));
  advRow.appendChild(advTexts);
  advRow.appendChild(detailButton(ctx, "advanced", tr("web.setup.security.advanced")));
  box.appendChild(advRow);
  return box;
}

function detailButton(ctx: SetupContext, group: string, title: string): HTMLButtonElement {
  const btn = h("button", "setup-detail-btn");
  btn.type = "button";
  btn.appendChild(h("span", "g", "⚙"));
  btn.appendChild(h("span", "t", tr("web.setup.security.configure")));
  btn.title = title;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    openSecurityPopup(ctx, group, title);
  });
  return btn;
}

let popup: HTMLElement | null = null;

export function closePopup(): void {
  if (popup && popup.parentNode) popup.parentNode.removeChild(popup);
  popup = null;
}

function openSecurityPopup(ctx: SetupContext, group: string, title: string): void {
  const overlay = h("div", "setup-overlay");
  const modal = h("div", "setup-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");

  const head = h("div", "setup-modal-head");
  const hIcon = h("span", "glyph", "⚙");
  head.appendChild(hIcon);
  head.appendChild(h("span", "setup-modal-title", title));
  const close = h("button", "setup-modal-x", "✕");
  close.type = "button";
  close.addEventListener("click", closePopup);
  head.appendChild(close);
  modal.appendChild(head);

  const body = h("div", "setup-modal-body");
  body.appendChild(h("p", "setup-hint", tr("web.setup.security.popup_hint")));
  SECURITY_POPUPS[group].forEach(([path, type, labelKey]) => {
    body.appendChild(
      popupField(ctx.state.answers.securityDetail, path, type, tr(labelKey)),
    );
  });
  modal.appendChild(body);

  const foot = h("div", "setup-modal-foot");
  const reset = h("button", "setup-btn link", tr("web.setup.security.reset"));
  reset.type = "button";
  reset.addEventListener("click", () => {
    const defaults: Dict =
      (ctx.state.display && ctx.state.display.defaults && ctx.state.display.defaults.security) ||
      {};
    (GROUP_KEYS[group] || [group]).forEach((src) => {
      const fresh: Dict = defaults[src] || {};
      Object.keys(fresh).forEach((k) =>
        setPath(ctx.state.answers.securityDetail, src + "." + k, fresh[k]),
      );
    });
    closePopup();
    openSecurityPopup(ctx, group, title);
  });
  foot.appendChild(reset);
  foot.appendChild(h("span", "spacer"));
  const done = h("button", "setup-btn primary", tr("web.setup.security.popup_done"));
  done.type = "button";
  done.addEventListener("click", closePopup);
  foot.appendChild(done);
  modal.appendChild(foot);

  overlay.appendChild(modal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePopup();
  });
  popup = overlay;
  ctx.gate.appendChild(overlay);
}
