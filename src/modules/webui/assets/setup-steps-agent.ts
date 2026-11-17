/** Шаги 3.0–3.2: раздел «Агент», критик и веб-поиск. */
import type { SetupContext } from "./setup-context.js";
import { h, stepBody } from "./setup-dom.js";
import { tr } from "./setup-i18n.js";

/** 3.0 — короткий разделитель перед настройками агента. */
export function renderAgentIntro(_ctx: SetupContext): HTMLElement {
  const box = stepBody("agent");
  const list = h("ul", "setup-agent-list");
  for (const key of ["critic", "websearch", "appearance", "security"]) {
    const item = h("li", "setup-agent-item");
    item.appendChild(h("span", "g", "◇"));
    item.appendChild(h("span", "t", tr("web.setup.agent.item_" + key)));
    list.appendChild(item);
  }
  box.appendChild(list);
  return box;
}

/** 3.1 — критик: вкл/выкл с объяснением. */
export function renderCritic(ctx: SetupContext): HTMLElement {
  const box = stepBody("critic");
  box.appendChild(toggleRow(ctx, "criticEnabled", "critic"));
  return box;
}

/** 3.2 — веб-поиск: вкл/выкл с объяснением. */
export function renderWebSearch(ctx: SetupContext): HTMLElement {
  const box = stepBody("websearch");
  box.appendChild(toggleRow(ctx, "webSearchEnabled", "websearch"));
  return box;
}

/** Строка-тумблер «название + пояснение». */
function toggleRow(
  ctx: SetupContext,
  answerKey: "criticEnabled" | "webSearchEnabled",
  i18nKey: string,
): HTMLElement {
  const row = h("div", "setup-sec-row setup-toggle-card");
  const label = h("label", "setup-toggle");
  const cb = h("input");
  cb.type = "checkbox";
  cb.checked = Boolean(ctx.state.answers[answerKey]);
  cb.addEventListener("change", () => {
    ctx.state.answers[answerKey] = cb.checked;
  });
  label.appendChild(cb);
  const texts = h("span", "setup-toggle-texts");
  texts.appendChild(h("span", "t", tr(`web.setup.${i18nKey}.toggle`)));
  const desc = tr(`web.setup.${i18nKey}.toggle_desc`);
  if (desc !== `web.setup.${i18nKey}.toggle_desc`) {
    texts.appendChild(h("span", "d", desc));
  }
  label.appendChild(texts);
  row.appendChild(label);
  return row;
}
