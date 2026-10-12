// Футер под композером: путь workspace и версия агента (справа).
// Листовой модуль без зависимости на `dom.js` — элемент передаётся аргументом,
// поэтому рендер тестируется в изоляции (tests/webui-workspace-footer.test.ts).

/** Вход футера: всё, что нужно знать о текущем ходе. */
export interface FooterInput {
  /** Каталог workspace агента (абсолютный). */
  workspace?: string;
  /** Версия установленного пакета. */
  version?: string;
  /** Доступный апдейт (`current` → `latest`); чип с подсказкой-командой. */
  updateAvailable?: { current: string; latest: string };
  /** Локализованная подпись «dir». */
  dirLabel: string;
  /** Локализованный title чипа апдейта. */
  updateTitle?: string;
}

/**
 * Собирает футер: `dir <path>` … `mma <version>` (+ чип апдейта).
 *
 * Прогресс хода виден по строке чата и карточкам тулов, поэтому отдельного
 * счётчика в футере нет.
 */
export function renderFooter(
  el: HTMLElement,
  input: FooterInput,
  make: (tag: string, cls: string, text: string) => HTMLElement,
): void {
  const {
    workspace = "",
    version = "",
    updateAvailable = undefined,
    dirLabel,
    updateTitle = "",
  } = input;
  const key = `${workspace} ${version} ${updateAvailable?.latest ?? ""}`;
  // Перестраиваем только на смену входа: `renderState` дёргает рендер на каждый
  // снимок состояния (план/usage/фаза), а DOM-трогать там нечего.
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.textContent = "";
  el.hidden = !workspace && !version && !updateAvailable;
  if (workspace) {
    el.appendChild(make("span", "ws-k", dirLabel));
    const v = make("span", "ws-v", workspace);
    v.title = workspace;
    el.appendChild(v);
  }
  // Available update: `↑ 2.37.0` next to the installed `mma 2.36.0`. The arrow
  // reads as "newer available" at a glance, the title carries the command —
  // `autoInstall` defaults to off, so the user installs it themselves.
  if (updateAvailable) {
    const chip = make("span", "ws-upd", `↑ ${updateAvailable.latest}`);
    chip.title = updateTitle;
    el.appendChild(chip);
  }
  if (version) {
    const v = make("span", "ws-ver", `mma ${version}`);
    v.title = `micro-models-agent ${version}`;
    el.appendChild(v);
  }
}