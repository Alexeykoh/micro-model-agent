// Git-чипы под полем ввода (спека git-workflow §6.3/§7): чистый листовой модуль.
//
// `buildGitChips` — только данные → описатели чипов (тестируется без DOM и без
// i18n: подписи приходят аргументом, как `dirLabel` в `footer.ts`). Рендер
// добавляет их в строку футера; схлопывание по ширине делает CSS по media-классам
// (`.gchip-optional`, полно/компакт-варианты), ширину в рантайме не считаем.

/** Минимальный вход чипов — срез `GitSnapshot` (вебу не нужен весь серверный тип). */
export interface GitChipsInput {
  repo?: boolean;
  branch?: string;
  detached?: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  dirty?: number;
  worktrees?: { path: string; branch: string }[];
  tags?: string[];
}

/** Локализованные подписи (ставит `feed/sidebar.ts` через `t()`). */
export interface GitChipStrings {
  /** `изменения` — к `● N`. */
  changes: string;
  /** Подсказка чипа ветки: `{branch}`. */
  branchTitle: string;
  /** Подсказка detached: `{branch}`. */
  detachedTitle: string;
  /** `worktree` + подсказка со списком путей. */
  worktrees: string;
  /** Подсказка синхронизации: `{upstream}`. */
  syncTitle: string;
  /** `тег`/`tag`. */
  tag: string;
}

export interface GitChip {
  /** CSS-классы: `gchip` + модификаторы (`gchip-optional`, `gchip-dirty`). */
  cls: string;
  /** Полная форма для широкого экрана. */
  text: string;
  /** Компактная форма (узкий экран); равна `text`, если компакт не нужен. */
  short: string;
  /** Есть ли компактный вариант (рендерит вторую span-ветку). */
  compact: boolean;
  title: string;
  /** `changes` — чип кликабелен (открывает вкладку Changes). */
  action?: string;
}

/**
 * Описатели чипов слева направо: `⎇ branch` → `⌂ worktrees` → `● N` →
 * `↑N ↓M` → `◇ tag`. Не-репозиторий — пустой массив (чипы скрыты целиком,
 * «no git» не показываем).
 */
export function buildGitChips(snap: GitChipsInput | null | undefined, s: GitChipStrings): GitChip[] {
  if (!snap || snap.repo !== true) return [];
  const chips: GitChip[] = [];

  const branch = snap.branch || "";
  const detached = snap.detached === true;
  const branchText = `⎇ ${detached ? `(detached@${branch})` : branch || "(no branch)"}`;
  chips.push({
    cls: "gchip gchip-branch",
    text: branchText,
    short: branchText,
    compact: false,
    title: detached ? s.detachedTitle.replace("{branch}", branch) : s.branchTitle.replace("{branch}", branch),
  });

  const extra = (snap.worktrees?.length ?? 0) - 1;
  if (extra > 0) {
    const paths = (snap.worktrees ?? []).map((w) => w.path).join("\n");
    chips.push({
      cls: "gchip gchip-wt gchip-optional",
      text: `⌂ ${extra} ${s.worktrees}`,
      short: `⌂${extra}`,
      compact: true,
      title: `${s.worktrees}\n${paths}`,
    });
  }

  const dirty = snap.dirty ?? 0;
  if (dirty > 0) {
    chips.push({
      cls: "gchip gchip-dirty",
      text: `● ${dirty} ${s.changes}`,
      short: `●${dirty}`,
      compact: true,
      title: s.changes,
      action: "changes",
    });
  }

  const ahead = snap.ahead ?? 0;
  const behind = snap.behind ?? 0;
  if (snap.upstream && (ahead > 0 || behind > 0)) {
    chips.push({
      cls: "gchip gchip-sync gchip-optional",
      text: `↑${ahead} ↓${behind}`,
      short: "↑↓",
      compact: true,
      title: s.syncTitle.replace("{upstream}", String(snap.upstream)),
    });
  }

  const tags = snap.tags ?? [];
  if (tags.length > 0) {
    const more = tags.length > 1 ? ` +${tags.length - 1}` : "";
    chips.push({
      cls: "gchip gchip-tag gchip-optional",
      text: `◇ ${tags[0]}${more}`,
      short: `◇${tags[0]}`,
      compact: true,
      title: tags.join(", "),
    });
  }
  return chips;
}

/**
 * Рендер чипов в контейнер строки футера. `make` создаёт элемент (как в
 * `renderFooter`) — модуль не тянет `dom.js` и потому тестируется в изоляции.
 */
export function renderGitChips(
  host: HTMLElement,
  snap: GitChipsInput | null | undefined,
  s: GitChipStrings,
  make: (tag: string, cls: string, text: string) => HTMLElement,
  onAction?: (action: string) => void,
): void {
  const chips = buildGitChips(snap, s);
  // Перестройка только на смену входа (state-тик дёргает рендер часто).
  const key = JSON.stringify(chips);
  if (host.dataset.gitKey === key) return;
  host.dataset.gitKey = key;
  host.textContent = "";
  host.hidden = chips.length === 0;
  for (const c of chips) {
    const chip = make("span", c.cls, "");
    chip.title = c.title;
    const full = make("span", "gchip-full", c.text);
    chip.appendChild(full);
    if (c.compact) chip.appendChild(make("span", "gchip-min", c.short));
    if (c.action && onAction) {
      chip.classList.add("gchip-link");
      chip.addEventListener("click", () => onAction(c.action as string));
    }
    host.appendChild(chip);
  }
}
