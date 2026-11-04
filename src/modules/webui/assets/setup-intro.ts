/** Знакомство с агентом на первом шаге визарда: что это, как работает и что понадобится. */
import { h } from "./setup-dom.js";
import { tr } from "./setup-i18n.js";

/** Пункты «понадобится»: ключ i18n + пояснение. */
const NEEDS = ["url", "key", "model", "context"] as const;

export function renderIntro(): HTMLElement {
  const box = h("div", "setup-intro");
  box.appendChild(h("p", "setup-intro-lead", tr("web.setup.intro.lead")));
  box.appendChild(h("p", "setup-intro-line", tr("web.setup.intro.model")));
  box.appendChild(h("p", "setup-intro-needs-title", tr("web.setup.intro.needs")));
  const list = h("ul", "setup-intro-needs");
  for (const need of NEEDS) {
    const item = h("li", "need");
    item.appendChild(h("span", "k", tr(`web.setup.intro.need_${need}`)));
    item.appendChild(h("span", "d", tr(`web.setup.intro.need_${need}_desc`)));
    list.appendChild(item);
  }
  box.appendChild(list);
  box.appendChild(h("p", "setup-intro-foot", tr("web.setup.intro.footnote")));
  return box;
}
