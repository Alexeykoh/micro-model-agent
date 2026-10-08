// Футер под композером: путь workspace, чип режима MoE и версия агента (справа).
// Листовой модуль без зависимости на `dom.js` — элемент передаётся аргументом,
// поэтому рендер тестируется в изоляции (tests/webui-workspace-footer.test.ts).

/** Вход футера: всё, что нужно знать о текущем ходе. */
export interface FooterInput {
  /** Каталог workspace агента (абсолютный). */
  workspace?: string;
  /** Версия установленного пакета. */
  version?: string;
  /** MoE реально ведёт ход (не `moe.enabled`) — горит чип режима. */
  moeActive?: boolean;
  /** Локализованная подпись «dir». */
  dirLabel: string;
}

/**
 * Собирает футер: `dir <path>` … `MoE` `mma <version>`.
 *
 * Чип MoE — простой факт, а не счётчик сабтасков: прогресс и так виден по
 * строке чата и карточкам `subagent`, а точный `done/total` потребовал бы
 * прокидывать прогресс в снапшот и обновлять его на каждый сабтаск.
 */
export function renderFooter(
  el: HTMLElement,
  input: FooterInput,
  make: (cls: string, text: string) => HTMLElement,
): void {
  const { workspace = "", version = "", moeActive = false, dirLabel } = input;
  const key = `${workspace} ${version} ${moeActive}`;
  // Перестраиваем только на смене входа: `renderState` дёргает рендер на каждый
  // снимок состояния (план/usage/фаза), а DOM-трогать там нечего.
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.textContent = "";
  el.hidden = !workspace && !version && !moeActive;
  if (workspace) {
    el.appendChild(make("ws-k", dirLabel));
    const v = make("ws-v", workspace);
    v.title = workspace;
    el.appendChild(v);
  }
  if (moeActive) {
    const chip = make("ws-moe", "MoE");
    chip.title = "MoE is orchestrating this turn";
    el.appendChild(chip);
  }
  if (version) {
    const v = make("ws-ver", `mma ${version}`);
    v.title = `micro-models-agent ${version}`;
    el.appendChild(v);
  }
}