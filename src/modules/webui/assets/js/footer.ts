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
  /** Доступный апдейт (`current` → `latest`); чип с подсказкой-командой. */
  updateAvailable?: { current: string; latest: string };
  /** Локализованная подпись «dir». */
  dirLabel: string;
  /** Локализованный title чипа апдейта. */
  updateTitle?: string;
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
  const {
    workspace = "",
    version = "",
    moeActive = false,
    updateAvailable = undefined,
    dirLabel,
    updateTitle = "",
  } = input;
  const key = `${workspace} ${version} ${moeActive} ${updateAvailable?.latest ?? ""}`;
  // Перестраиваем только на смену входа: `renderState` дёргает рендер на каждый
  // снимок состояния (план/usage/фаза), а DOM-трогать там нечего.
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.textContent = "";
  el.hidden = !workspace && !version && !moeActive && !updateAvailable;
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
  // Available update: `↑ 2.37.0` next to the installed `mma 2.36.0`. The arrow
  // reads as "newer available" at a glance, the title carries the command —
  // `autoInstall` defaults to off, so the user installs it themselves.
  if (updateAvailable) {
    const chip = make("ws-upd", `↑ ${updateAvailable.latest}`);
    chip.title = updateTitle;
    el.appendChild(chip);
  }
  if (version) {
    const v = make("ws-ver", `mma ${version}`);
    v.title = `micro-models-agent ${version}`;
    el.appendChild(v);
  }
}