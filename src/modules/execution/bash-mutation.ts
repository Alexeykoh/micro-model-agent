// Классификация bash-команды: меняет ли она файлы/состояние репозитория.
import { maskQuotedShell } from "../security/command-quotes";

/** Глаголы, которые всегда пишут на диск (или меняют состояние каталога). */
const MUTATING_VERBS = new Set([
  "cp",
  "mv",
  "mkdir",
  "rmdir",
  "rm",
  "del",
  "erase",
  "touch",
  "tee",
  "chmod",
  "chown",
  "ln",
  "truncate",
  "dd",
  "shred",
  "unzip",
  "tar",
  "rsync",
  "scp",
]);

/**
 * Глаголы, которые только читают. Список нужен, потому что «всё незнакомое —
 * мутация» (fail-open) иначе превращало `ls`/`cat`/`grep` в «изменяющие файлы».
 */
const READ_ONLY_VERBS = new Set([
  "ls",
  "dir",
  "cat",
  "type",
  "head",
  "tail",
  "grep",
  "rg",
  "find",
  "wc",
  "sort",
  "uniq",
  "cut",
  "awk",
  "sed",
  "jq",
  "echo",
  "printf",
  "pwd",
  "which",
  "where",
  "whoami",
  "date",
  "env",
  "printenv",
  "stat",
  "file",
  "diff",
  "md5sum",
  "sha256sum",
  "tree",
  "du",
  "df",
  "ps",
  "ping",
  "nslookup",
  "dig",
  "hostname",
  "uname",
  "test",
  "true",
  "sleep",
]);

/**
 * Инструменты-обёртки, у которых мутирует только часть подкоманд.
 * `git status`, `docker ps`, `npm ls` — чтение; `git commit`, `docker cp` — запись.
 */
const SUBCOMMAND_MUTATIONS: Record<string, Set<string>> = {
  git: new Set([
    "add",
    "commit",
    "checkout",
    "switch",
    "merge",
    "rebase",
    "reset",
    "restore",
    "apply",
    "am",
    "stash",
    "push",
    "tag",
    "clean",
    "init",
    "pull",
    "cherry-pick",
    "revert",
  ]),
  docker: new Set(["build", "run", "cp", "rm", "rmi", "tag", "commit", "load", "import", "push"]),
  npm: new Set(["install", "i", "ci", "uninstall", "update", "version", "publish", "link"]),
  bun: new Set(["install", "add", "remove", "update", "link", "publish"]),
  pnpm: new Set(["install", "add", "remove", "update"]),
  yarn: new Set(["install", "add", "remove", "upgrade"]),
  pip: new Set(["install", "uninstall"]),
  pip3: new Set(["install", "uninstall"]),
  apt: new Set(["install", "remove", "update", "upgrade"]),
  "apt-get": new Set(["install", "remove", "update", "upgrade"]),
};

/** Читающие подкоманды известных инструментов (иначе — fail-open в мутацию). */
const READ_ONLY_SUBS: Record<string, Set<string>> = {
  git: new Set([
    "status",
    "log",
    "diff",
    "show",
    "branch",
    "remote",
    "rev-parse",
    "ls-files",
    "blame",
    "describe",
  ]),
  docker: new Set(["ps", "logs", "inspect", "images", "version", "info", "stats", "top", "port"]),
  npm: new Set(["ls", "list", "view", "outdated", "audit", "run", "exec"]),
  bun: new Set(["run", "test", "x", "pm"]),
  pnpm: new Set(["ls", "list", "run"]),
  yarn: new Set(["run", "list"]),
  pip: new Set(["list", "show", "freeze"]),
  pip3: new Set(["list", "show", "freeze"]),
};

/** Подкоманды `docker compose <x>` / `docker-compose <x>`, меняющие состояние. */
const COMPOSE_MUTATIONS = new Set([
  "up",
  "down",
  "build",
  "start",
  "stop",
  "restart",
  "rm",
  "run",
  "create",
]);

/** Обёртки, чьи опции нужно пропустить перед реальной командой. */
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "exec", "nohup", "nice", "timeout"]);

/** Токены команды с вырезанными кавычками и обёртками. */
function words(command: string): string[] {
  const tokens = command
    .replace(/["']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      i++;
      continue;
    }
    if (WRAPPERS.has(tok)) {
      i++;
      while (
        i < tokens.length &&
        (tokens[i].startsWith("-") || /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[i]))
      ) {
        i += tokens[i].startsWith("-") && tokens[i].includes("=") ? 1 : 2;
      }
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

/**
 * Пишет ли `curl`/`wget` в файл (`-o file`, `-O`, `--output file`).
 * `-O /dev/null` и `-o -` — не запись в проект.
 */
function downloadsToFile(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-O" || a === "--remote-name") return true;
    if (a === "-o" || a === "--output") {
      const target = args[i + 1];
      if (!target || target === "-" || target === "/dev/null") return false;
      return true;
    }
    if (a.startsWith("--output=")) {
      const target = a.slice("--output=".length);
      return target !== "-" && target !== "/dev/null";
    }
    if (/^-[a-zA-Z]*[oO]/.test(a) && !a.startsWith("--")) {
      // Склейка флагов (`-qO file`): значение — следующий токен.
      const target = args[i + 1];
      if (a.includes("O")) return !target || (target !== "-" && target !== "/dev/null");
      if (!target || target === "-" || target === "/dev/null") return false;
      return true;
    }
  }
  return false;
}

/**
 * Может ли bash-команда изменить файлы/состояние (и значит — требовать плана).
 *
 * Зачем: `mutationsWithoutPlan` считал мутацией **любой** `bash`. В
 * `ses_mvphq4s8` (итерация 6) это дало «Ты сделал(а) 2 вызова, изменяющих
 * файлы» на чисто read-only диагностике (`docker ps`, `ls`), и агент создал
 * план, которого задача не требовала (гвард: tests/modules/execution/plan-nudge-mutation.test.ts).
 *
 * Правила: редирект `>` вне кавычек, `sed -i`/`perl -i`, глагол из
 * `MUTATING_VERBS`, подкоманда из таблиц, `curl`/`wget` с выводом в файл —
 * мутация. Глагол из `READ_ONLY_VERBS` — чтение. Всё остальное — **мутация**
 * (fail-open: фикс не должен открывать обход плана).
 *
 * @param command сырая команда bash-тула.
 * @returns true, если команда может писать.
 */
export function bashMutatesFiles(command: string): boolean {
  const masked = maskQuotedShell(command);
  // Редирект пишет в файл; `2>&1` / `>&2` — дубли дескрипторов, не файлы.
  const noDup = masked.replace(/\d?>&\d/g, "").replace(/&>\d/g, "");
  if (noDup.includes(">")) return true;
  if (/\b(?:sed|perl|ruby)\b[^|;&]*\s(?:-i|--in-place)\b/.test(masked)) return true;

  return mutatesTokens(words(masked));
}

/** Классификация по токенам (рекурсивно для `docker exec`). */
function mutatesTokens(tokens: string[]): boolean {
  const verb = (tokens[0] ?? "").replace(/^.*[\\/]/, "");
  if (!verb) return false;
  if (MUTATING_VERBS.has(verb)) return true;
  if (verb === "curl" || verb === "wget") return downloadsToFile(tokens.slice(1));

  const subs = SUBCOMMAND_MUTATIONS[verb];
  if (!subs) return !READ_ONLY_VERBS.has(verb);

  const sub = tokens[1] ?? "";
  if (verb === "docker" && sub === "compose") {
    return COMPOSE_MUTATIONS.has(tokens[2] ?? "");
  }
  if (verb === "docker" && sub === "exec") {
    // `docker exec <контейнер> <команда…>` — судим по внутренней команде.
    const rest = tokens.slice(2).filter((t) => !t.startsWith("-"));
    return mutatesTokens(rest.slice(1));
  }
  if (!sub) return true;
  if (subs.has(sub)) return true;
  return !(READ_ONLY_SUBS[verb]?.has(sub) ?? false);
}
