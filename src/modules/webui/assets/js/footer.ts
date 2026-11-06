// Футер под композером: путь workspace, git-состояние и версия агента.
// Листовой модуль без зависимости на `dom.js` — элемент передаётся аргументом,
// поэтому рендер тестируется в изоляции (tests/webui-workspace-footer.test.ts).

/** Git-состояние для инлайн-бейджа в строке футера. */
export interface FooterGit {
  repo?: boolean;
  branch?: string;
  detached?: boolean;
  dirty?: number;
  ahead?: number;
  behind?: number;
  tags?: string[];
}

/** Вход футера: всё, что нужно знать о текущем ходе. */
export interface FooterInput {
  /** Каталог workspace агента (абсолютный). */
  workspace?: string;
  /** Версия установленного пакета. */
  version?: string;
  /** Доступный апдейт (`current` → `latest`); чип с подсказкой-командой. */
  updateAvailable?: { current: string; latest: string };
  /** Локальная dev-сборка (запуск из src/, а не из dist/). */
  dev?: boolean;
  /** Локализованный title для метки dev. */
  devTitle?: string;
  /** Локализованная подпись «dir». */
  dirLabel: string;
  /** Локализованный title чипа апдейта. */
  updateTitle?: string;
  /**
   * Git-состояние workspace. Рисуется В ТОЙ ЖЕ строке, сразу за путём:
   * отдельная строка под футером читалась как «всё по одной штуке в столбик».
   */
  git?: FooterGit | null;
  /** Локализованные подписи git-чипов (готовые строки, без t() внутри). */
  gitLabels?: { changes: string; detached: string };
}

/**
 * Собирает футер: `dir <path> ⎇ branch ●N … mma <version>` (+ чип апдейта).
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
    dev = false,
    dirLabel,
    updateTitle = "",
    devTitle = "",
    git = null,
    gitLabels,
  } = input;
  const chips = buildGitChips(git, gitLabels);
  const key = JSON.stringify([
    workspace, version, dev, updateAvailable?.latest ?? "", dirLabel, chips,
  ]);
  // Перестраиваем только на смену входа: `renderState` дёргает рендер на каждый
  // снимок состояния (план/usage/фаза), а DOM-трогать там нечего.
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.textContent = "";
  el.hidden = !workspace && !version && !updateAvailable && !dev && chips.length === 0;
  if (workspace) {
    el.appendChild(make("span", "ws-k", dirLabel));
    const v = make("span", "ws-v", workspace);
    v.title = workspace;
    el.appendChild(v);
  }
  // Git — сразу после пути, в той же строке: одна строка вместо двух.
  for (const chip of chips) {
    const node = make("span", chip.cls, chip.text);
    if (chip.title) node.title = chip.title;
    el.appendChild(node);
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
  if (dev) {
    const d = make("span", "ws-dev", "dev");
    d.title = devTitle;
    el.appendChild(d);
  }
}

/** Один инлайн-чип футера: класс, видимый текст и подсказка. */
interface InlineChip {
  cls: string;
  text: string;
  title: string;
}

/**
 * Git-чипы для строки футера. На виду — ветка и число изменений (решение
 * пользователя): остальное (ahead/behind, worktree, тег) уходит в tooltip,
 * чтобы строка не спорила по ширине с путём и версией. Вне репозитория —
 * пусто: «no git» под композером был бы шумом.
 */
export function buildGitChips(git: FooterGit | null, labels?: FooterInput["gitLabels"]): InlineChip[] {
  if (!git || git.repo !== true) return [];
  const changes = labels?.changes ?? "changes";
  const detachedLabel = labels?.detached ?? "detached";
  const chips: InlineChip[] = [];

  const branch = git.branch || "";
  const head = git.detached ? `${detachedLabel}@${branch}` : branch || "—";
  const extra: string[] = [];
  const ahead = git.ahead ?? 0;
  const behind = git.behind ?? 0;
  if (ahead > 0 || behind > 0) extra.push(`↑${ahead} ↓${behind}`);
  if (git.tags?.length) extra.push(`◇ ${git.tags.join(", ")}`);
  chips.push({
    cls: "gchip gchip-branch",
    text: `⎇ ${head}`,
    title: ["branch: " + head, ...extra].join("\n"),
  });

  const dirty = git.dirty ?? 0;
  if (dirty > 0) {
    chips.push({
      cls: "gchip gchip-dirty",
      text: `● ${dirty} ${changes}`,
      title: `${changes}: ${dirty}`,
    });
  }
  return chips;
}
