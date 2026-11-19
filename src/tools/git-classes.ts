/**
 * Единая классификация git-операций (INV-G1, спека `2026-08-08-git-workflow-design`).
 *
 * Один список субкоманд и флагов читается двумя поверхностями:
 *  · `src/tools/git.ts` — destructive → подтверждение `approve`;
 *  · `src/modules/security/command-shapes.ts` — destructive → блок в `bash`.
 *
 * Класс считается по argv БЕЗ шелла: `read` ничего не меняет и кешируем,
 * `mutate` меняет репозиторий, `destructive` уничтожает историю/данные или
 * исполняет произвольный код (внешние программы, редирект в другой репозиторий).
 * Неизвестная субкоманда — `destructive` (fail-closed).
 */
export type GitOpClass = "read" | "mutate" | "destructive";

/** Глобальные опции со значением: их аргумент нельзя путать с субкомандой. */
const GLOBAL_VALUE_OPTS = new Set(["-C", "-c", "--config-env", "--git-dir", "--work-tree", "--exec-path", "--namespace", "--super-prefix"]);

/**
 * Опции-векторы: уводят операцию за рабочий каталог (`-C`, `--git-dir`,
 * `--work-tree`) или подставляют конфигурацию с исполнением кода
 * (`-c core.pager=…`, `--exec-path`). Форма `--opt=value` ловится по префиксу.
 */
const JAIL_OPTS = new Set(["-C", "-c", "--config-env", "--git-dir", "--work-tree", "--exec-path", "--namespace"]);

/** Флаги, запускающие внешние программы вне контроля агента. */
const EXEC_FLAGS = new Set(["--ext-diff", "--unsafe-paths", "--extcap"]);

/** Субкоманды, которые никогда ничего не меняют. */
const READ = new Set([
  "blame", "cat-file", "cherry", "count-objects", "describe", "diff", "diff-files",
  "diff-index", "diff-tree", "for-each-ref", "fsck", "grep", "help", "log",
  "ls-files", "ls-remote", "ls-tree", "merge-base", "merge-tree", "name-rev",
  "reflog", "rev-list", "rev-parse", "show", "show-branch", "show-ref",
  "shortlog", "status", "var", "verify-commit", "verify-pack", "verify-tag",
  "version", "whatchanged",
]);

/** Субкоманды, меняющие состояние репозитория без уничтожения истории. */
const MUTATE = new Set([
  "add", "am", "bisect", "bundle", "checkout", "cherry-pick", "clone", "commit",
  "fetch", "gc", "index-pack", "init", "maintenance", "merge", "merge-file",
  "pull", "push", "rebase", "remote", "reset", "restore", "rerere", "rm",
  "sequence-editor", "stage", "stash", "switch", "update-ref", "worktree",
]);

/** Субкоманды всегда разрушительные: переписывают историю или зовут внешнее. */
const DESTRUCTIVE = new Set([
  "difftool", "filter-branch", "mergetool", "prune", "prune-packed", "replace",
  "clean", "config", "notes",
]);

/** Долгие флаги-разрушители по субкоманде (`--flag` или `--flag=…`). */
const DESTRUCTIVE_LONG: Record<string, string[]> = {
  branch: ["--delete", "--unset-upstream", "--edit"],
  tag: ["--delete", "--force"],
  reset: ["--hard", "--merge", "--keep"],
  checkout: ["--force", "--ours", "--theirs"],
  switch: ["--discard-changes", "--overwrite"],
  restore: ["--ours", "--theirs", "--ignore-skip-worktree-bits"],
  rebase: ["--abort", "--skip", "--quit"],
  commit: ["--amend", "--no-verify"],
  apply: ["--force"],
  rm: ["-f", "--force"],
  mv: ["-f", "--force"],
  "update-ref": ["-d", "--delete"],
  "symbolic-ref": ["-d", "--delete"],
  worktree: ["--force"],
  stash: ["--force"],
  push: ["--force", "--force-with-lease", "--delete", "--prune", "--mirror", "--no-verify"],
  remote: ["remove", "rm", "set-head", "--delete", "set-url"],
  config: ["--unset", "--unset-all", "--remove-section", "--global", "--system", "--file"],
  gc: ["--prune"],
  clean: ["-e"],
};

/** Короткие флаги-разрушители (буквы; проверяются и в бандлах вида `-fdx`). */
const DESTRUCTIVE_SHORT: Record<string, string[]> = {
  branch: ["d", "D"],
  tag: ["d", "f"],
  clean: ["f", "x"],
  checkout: ["f"],
  rm: ["f"],
  mv: ["f"],
  "update-ref": ["d"],
  "symbolic-ref": ["d"],
  stash: ["d"],
  push: ["f"],
  apply: ["f"],
};

/** Читающие подоперации/флаги, понижающие разрушительную команду до `read`. */
const SUB_READ: Record<string, string[]> = {
  branch: ["--list", "--all", "-a", "-r", "--remotes", "--show-current", "--contains", "--merged", "--no-merged"],
  tag: ["--list", "-l", "--contains", "--points-at", "--sort", "--merged", "--no-merged"],
  remote: ["show", "get-url", "-v", "--verbose"],
  stash: ["list", "show"],
  config: ["get", "get-all", "get-regexp", "--get", "--list", "-l"],
  worktree: ["list"],
  notes: ["list", "show", "get"],
  clean: ["-n", "--dry-run"],
  rm: ["-n", "--dry-run"],
  mv: ["-n", "--dry-run"],
  apply: ["--check", "--stat", "--numstat"],
  push: ["-n", "--dry-run"],
  "symbolic-ref": ["-q"],
};

/** Позиционные токены, повышающие команду до `destructive`. */
const SUB_DESTRUCTIVE: Record<string, string[]> = {
  stash: ["drop", "clear"],
  notes: ["remove", "prune", "merge", "rewrite"],
  remote: ["remove", "rm", "set-head", "set-url", "prune"],
  worktree: ["prune", "remove", "lock", "unlock"],
  rebase: ["switch", "switch-to"],
};

/** Обёртки шелла, после которых может стоять `git` (совпадение с command-validator). */
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "exec", "nohup", "nice", "timeout"]);

/** Есть ли долгий флаг (или `--flag=…`) среди токенов. */
function hasLong(tokens: string[], flag: string): boolean {
  return tokens.some((t) => t === flag || t.startsWith(`${flag}=`));
}

/** Есть ли короткий флаг-буква, включая бандл `-fdx`. */
function hasShort(tokens: string[], letter: string): boolean {
  return tokens.some((t) => /^-[a-zA-Z]+$/.test(t) && t.slice(1).includes(letter));
}

/** Разделить argv на область глобальных опций и саму команду. */
export function splitGitArgv(argv: string[]): { global: string[]; rest: string[] } {
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (!tok.startsWith("-")) break;
    const base = tok.split("=")[0];
    i += GLOBAL_VALUE_OPTS.has(base) && !tok.includes("=") ? 2 : 1;
  }
  return { global: argv.slice(0, i), rest: argv.slice(i) };
}

/** Имя субкоманды ("" — `git` без аргументов). */
export function gitSubcommand(argv: string[]): string {
  const { rest } = splitGitArgv(argv);
  const tok = rest.find((t) => t && !t.startsWith("-"));
  return (tok ?? "").toLowerCase();
}

/** Вектор ухода из рабочего каталога/исполнения кода; `undefined` — чисто. */
export function gitJailViolation(argv: string[]): string | undefined {
  const { global, rest } = splitGitArgv(argv);
  for (const tok of [...global, ...rest]) {
    const base = tok.split("=")[0];
    if (JAIL_OPTS.has(base)) return base;
    if (EXEC_FLAGS.has(base)) return base;
  }
  return undefined;
}

/** Человекочитаемое имя операции для причины блока: `git reset --hard`. */
export function gitCommandName(argv: string[]): string {
  const sub = gitSubcommand(argv);
  if (!sub) return "git";
  const { rest } = splitGitArgv(argv);
  const idx = rest.findIndex((t) => t.toLowerCase() === sub);
  const tail = idx >= 0 ? rest.slice(idx + 1) : [];
  const flags = tail.filter((t) => t.startsWith("-"));
  const killer = (DESTRUCTIVE_LONG[sub] ?? []).find((f) => hasLong(flags, f))
    ?? (DESTRUCTIVE_SHORT[sub] ?? []).map((l) => flags.find((f) => hasShort([f], l))).find(Boolean);
  return killer ? `git ${sub} ${killer}` : `git ${sub}`;
}

/** Класс операции по argv (без ведущего `git`). Неизвестное — destructive. */
export function classifyGitArgv(argv: string[]): GitOpClass {
  // Jail-опции проверяем ПЕРВЫМИ: `git -c core.pager=…` без субкоманды — тоже
  // вектор исполнения кода, а ранний выход «нет субкоманды» дал бы ему `read`.
  if (gitJailViolation(argv)) return "destructive";
  const sub = gitSubcommand(argv);
  if (!sub) return "read"; // `git` без аргументов — справка

  const { rest } = splitGitArgv(argv);
  const idx = rest.findIndex((t) => t.toLowerCase() === sub);
  const tail = idx >= 0 ? rest.slice(idx + 1) : [];
  const flags = tail.filter((t) => t.startsWith("-"));
  const pos = tail.filter((t) => t && !t.startsWith("-")).map((t) => t.toLowerCase());

  // `git config get`/`remote show` — чтение; `stash drop` — удаление.
  if ((SUB_DESTRUCTIVE[sub] ?? []).includes(pos[0] ?? "")) return "destructive";
  if ((SUB_READ[sub] ?? []).some((f) => flags.includes(f) || pos.includes(f))) return "read";
  if ((DESTRUCTIVE_LONG[sub] ?? []).some((f) => hasLong(flags, f))) return "destructive";
  if ((DESTRUCTIVE_SHORT[sub] ?? []).some((l) => hasShort(flags, l))) return "destructive";

  if (sub === "branch" || sub === "tag") return pos.length ? "mutate" : "read";
  if (sub === "config" || sub === "remote" || sub === "notes" || sub === "symbolic-ref") {
    // Без явных разрушительных флагов: позиционный аргумент — запись.
    return pos.length ? "mutate" : "read";
  }
  if (sub === "worktree" || sub === "stash" || sub === "rebase" || sub === "bisect") {
    return pos[0] === "add" || sub === "stash" || sub === "rebase" || sub === "bisect" ? "mutate" : "read";
  }
  if (DESTRUCTIVE.has(sub)) return "destructive";
  if (READ.has(sub)) return "read";
  if (MUTATE.has(sub)) return "mutate";
  return "destructive";
}

/** Токенизация shell-строки: кавычки, перевод сегментов по `; | & \n`. */
export function tokenizeShellWords(command: string): string[][] {
  const segments: string[][] = [];
  let cur: string[] = [];
  let token = "";
  let quote: "" | "'" | '"' = "";
  const push = (): void => {
    if (token) {
      cur.push(token);
      token = "";
    }
  };
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = "";
      else token += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n" || ch === "\r") {
      push();
      if (cur.length) segments.push(cur);
      cur = [];
      continue;
    }
    token += ch;
  }
  push();
  if (cur.length) segments.push(cur);
  return segments;
}

/**
 * argv каждой git-команды в shell-строке (после env-присваиваний и обёрток).
 * Токены в нижнем регистре — сравнение классов регистронезависимо на FS Windows.
 */
export function parseGitShellCommand(command: string): string[][] {
  const out: string[][] = [];
  for (const seg of tokenizeShellWords(command)) {
    let i = 0;
    while (i < seg.length && (/^[a-zA-Z_][a-zA-Z0-9_]*=/.test(seg[i]) || WRAPPERS.has(seg[i].toLowerCase()))) i++;
    if (i >= seg.length) continue;
    const base = (seg[i].replace(/^["']+|["']+$/g, "").split(/[\\/]/).pop() ?? "").toLowerCase();
    if (base !== "git") continue;
    out.push(seg.slice(i + 1).map((t) => t.toLowerCase()));
  }
  return out;
}
