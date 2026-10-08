// Футер под композером: путь workspace + версия агента (справа). Листовой
// модуль без зависимости на `dom.js` — элемент передаётся аргументом, поэтому
// рендер тестируется в изоляции (см. tests/webui-workspace-footer.test.ts).

/** Собирает содержимое футера: `dir <path>` + `mma <version>` по краю. */
export function renderFooter(
  el: HTMLElement,
  ws: string,
  version: string,
  dirLabel: string,
  make: (cls: string, text: string) => HTMLElement,
): void {
  const key = `${ws} ${version}`;
  // Перестраиваем только на смене входа: `renderState` дёргает рендер на каждый
  // снимок состояния (план/usage/фаза), а DOM-трогать там нечего.
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.textContent = "";
  el.hidden = !ws && !version;
  if (ws) {
    el.appendChild(make("ws-k", dirLabel));
    const v = make("ws-v", ws);
    v.title = ws;
    el.appendChild(v);
  }
  if (version) {
    const v = make("ws-ver", `mma ${version}`);
    v.title = `micro-models-agent ${version}`;
    el.appendChild(v);
  }
}