/** Шаги 3.0–3.2: раздел «Агент», критик и веб-поиск. */
import type { SetupContext } from "./setup-context.js";
import { h, stepBody } from "./setup-dom.js";
import { tr } from "./setup-i18n.js";
import { toggleRow } from "./setup-switch.js";

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
  box.appendChild(
    toggleRow(
      ctx.state.answers.criticEnabled,
      tr("web.setup.critic.toggle"),
      tr("web.setup.critic.toggle_desc"),
      (next) => {
        ctx.state.answers.criticEnabled = next;
      },
    ),
  );
  return box;
}

/** 3.2 — веб-поиск: вкл/выкл с объяснением. */
export function renderWebSearch(ctx: SetupContext): HTMLElement {
  const box = stepBody("websearch");
  box.appendChild(
    toggleRow(
      ctx.state.answers.webSearchEnabled,
      tr("web.setup.websearch.toggle"),
      tr("web.setup.websearch.toggle_desc"),
      (next) => {
        ctx.state.answers.webSearchEnabled = next;
      },
    ),
  );
  return box;
}
