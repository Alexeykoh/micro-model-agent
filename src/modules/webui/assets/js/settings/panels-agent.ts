// Agent settings panel: verifier (critic) / experts / sub-agents / tools as
// focused tabs. Critic goes first and is the tab the panel opens on: it is the
// one switch every operator checks on entering Agent, so it must be visible
// without a click (the card itself is `agent.critic` in PANEL_SECTIONS.agent).
// The registry table stays the single source of truth.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import type { Dict } from "../core/store/types.js";
import { PANEL_SECTIONS } from "./controls.js";
import { renderSectionsInto } from "./panels-shared.js";

const TABS: Array<[string, string, string[]]> = [
  ["critic", "web.settings.tab_agent_critic", ["agent.critic", "agent.critic.tuning", "agent.hallucination"]],
  ["experts", "web.settings.tab_agent_experts", ["agent.experts"]],
  ["subagents", "web.settings.tab_agent_subagents", ["agent.subagent"]],
  ["tools", "web.settings.tab_agent_tools", ["agent.tools"]],
];

let activeTab = "critic";

export function renderAgentPanel(): void {
  const container = document.querySelector<HTMLElement>('[data-panel="agent"]');
  if (!container) return;
  container.textContent = "";
  const sections = PANEL_SECTIONS.agent || [];

  const panes: Record<string, HTMLElement> = {};
  const buttons = new Map<string, HTMLButtonElement>();
  const select = (key: string): void => {
    if (!panes[key]) return;
    activeTab = key;
    for (const [name, node] of Object.entries(panes)) node.hidden = name !== key;
    for (const [name, btn] of buttons) {
      btn.classList.toggle("on", name === key);
      btn.setAttribute("aria-selected", name === key ? "true" : "false");
    }
  };

  const tabs = el("div", "settings-tabs");
  tabs.setAttribute("role", "tablist");
  TABS.forEach(([key, labelKey, ids]) => {
    const pane = el("div", "settings-pane");
    pane.setAttribute("role", "tabpanel");
    pane.dataset.pane = key;
    renderSectionsInto(
      pane,
      sections.filter((s: Dict) => ids.includes(String(s.id))),
    );
    panes[key] = pane;

    const btn = el("button", "settings-tab", t(labelKey));
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.addEventListener("click", () => select(key));
    tabs.appendChild(btn);
    buttons.set(key, btn);
  });

  container.appendChild(tabs);
  Object.values(panes).forEach((node) => container.appendChild(node));
  select(activeTab);
}
