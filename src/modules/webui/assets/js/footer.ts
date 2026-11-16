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
  /**
   * Базовая ветка (непосредственный родитель по reflog создания) и полная
   * цепочка предков от корня (`["main","dev"]` для `feat`). Пусто — неизвестно:
   * чип остаётся просто `⎇ feat`, ничего не выдумываем.
   */
  base?: string;
  chain?: string[];
}

/** Вход футера: всё, что нужно знать о текущем ходе. */
export interface FooterInput {
  /** Каталог workspace агента (абсолютный). */
  workspace?: string;
  /** Путь скрыт политикой данных (DLP): рисовать замок вместо текста. */
  workspaceHidden?: boolean;
  /** Подсказка замка (локализованное «скрыто политикой данных»). */
  workspaceTitle?: string;
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

const SVG_NS = "http://www.w3.org/2000/svg";

/** Lucide lock (same table as the rest of the chrome), built without dom.js. */
function lockIcon(): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "svg-icon");
  const parts: Array<[string, Record<string, string | number>]> = [
    ["rect", { width: 18, height: 11, x: 3, y: 11, rx: 2, ry: 2 }],
    ["path", { d: "M7 11V7a5 5 0 0 1 10 0v4" }],
  ];
  parts.forEach(([tag, attrs]) => {
    const child = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs).forEach((k) => child.setAttribute(k, String(attrs[k])));
    svg.appendChild(child);
  });
  return svg;
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
    workspaceHidden = false,
    workspaceTitle = "",
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
    workspace, workspaceHidden, workspaceTitle, version, dev,
    updateAvailable?.latest ?? "", dirLabel, chips,
  ]);
  // Перестраиваем только на смену входа: `renderState` дёргает рендер на каждый
  // снимок состояния (план/usage/фаза), а DOM-трогать там нечего.
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.textContent = "";
  el.hidden =
    !workspace && !workspaceHidden && !version && !updateAvailable && !dev && chips.length === 0;
  if (workspace || workspaceHidden) {
    el.appendChild(make("span", "ws-k", dirLabel));
    if (workspaceHidden) {
      // DLP: the path itself must not leak, but the footer still has to say
      // "there is a workspace" — a gray lock icon plus the explanation on hover.
      const lock = make("span", "ws-lock dlp-lock", "");
      lock.appendChild(lockIcon());
      lock.title = workspaceTitle;
      lock.setAttribute("aria-label", workspaceTitle);
      el.appendChild(lock);
    } else {
      const v = make("span", "ws-v", workspace);
      v.title = workspace;
      el.appendChild(v);
    }
  }
  // Git — сразу после пути, в той же строке: одна строка вместо двух.
  for (const chip of chips) {
    const node = make("span", chip.cls, "");
    // Text goes into its own span: `text-overflow: ellipsis` does not apply to
    // an anonymous flex item, so a long branch chain used to be hard-clipped.
    node.appendChild(make("span", "gchip-text", chip.text));
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
  // Цепочка наследования стрелками (сухо, как просил пользователь):
  // `⎇ main → dev → feat`. Без известной базы — прежний одиночный `⎇ feat`.
  const path =
    !git.detached && git.chain?.length
      ? [...git.chain, branch].join(" → ")
      : !git.detached && git.base
        ? `${git.base} → ${branch}`
        : head;
  const extra: string[] = [];
  const ahead = git.ahead ?? 0;
  const behind = git.behind ?? 0;
  if (ahead > 0 || behind > 0) extra.push(`↑${ahead} ↓${behind}`);
  if (git.tags?.length) extra.push(`◇ ${git.tags.join(", ")}`);
  chips.push({
    cls: "gchip gchip-branch",
    text: `⎇ ${path}`,
    title: ["branch: " + head, ...(path === head ? [] : ["from: " + path]), ...extra].join("\n"),
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
