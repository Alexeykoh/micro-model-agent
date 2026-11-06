/**
 * Исполнение git БЕЗ шелла (`spawn("git", argv)`) и парсинг machine-вывода.
 * Спека `<PII:41a65c5d19d9>-git-workflow-design` §5/§6: здесь общая часть тула
 * `git` и веб-роутов — классификация живёт в `git-classes`, политика — в туле.
 *
 * Вывод читается `-z`/`--porcelain` форматами: никакого парсинга человекотекста.
 */
import { spawn } from "node:child_process";
import { gitJailViolation, gitSubcommand } from "./git-classes";

/** Дедлайн одного git-вызова (обёртка над subprocess, не LLM — отношений не имеет). */
export const GIT_TIMEOUT_MS = 5_000;
/** Кап тела diff в веб-ответе (байты и строки; сверх — `truncated`). */
export const GIT_DIFF_MAX_BYTES = 256 * 1024;
export const GIT_DIFF_MAX_LINES = 3000;
/** TTL серверного снимка статуса (вкладки/чипы), чтобы N клиентов не плодили `git status`. */
export const GIT_SNAPSHOT_TTL_MS = 5_000;

/** Результат исполнения argv (шелл недоступен по построению). */
export interface GitRunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  /** Причина отказа ДО запуска (уход из sandbox, не-argv) — не путать с `code!==0`. */
  blocked?: string;
  timedOut?: boolean;
}

/** Ключи env, уводящие git за рабочий каталог или подставляющие исполняемое. */
const POISON_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_SSH_COMMAND",
  "GIT_SSH",
  "GIT_PROXY_COMMAND",
  "GIT_ASKPASS",
  "GIT_PAGER",
  "GIT_SEQUENCE_EDITOR",
  "GIT_EDITOR",
  "EDITOR",
  "VISUAL",
  "PAGER",
];

/** Окружение запуска: без яда, без промптов, без постраничного пейджера. */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === "string" && !POISON_ENV.includes(k) && !k.startsWith("GIT_CONFIG_KEY_") && !k.startsWith("GIT_CONFIG_VALUE_")) env[k] = v;
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.GIT_MERGE_AUTOEDIT = "no";
  env.LC_ALL = "C";
  return env;
}

/**
 * Запускает `git argv` в `cwd`. Перед запуском — проверка jail-опций:
 * `-C`/`--git-dir`/`--work-tree`/`-c` дают уход за каталог и исполнение кода.
 */
export function runGit(cwd: string, argv: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitRunResult> {
  const violation = gitJailViolation(argv);
  if (violation) {
    return Promise.resolve({ ok: false, code: -1, stdout: "", stderr: "", blocked: `${violation} is not allowed — git operates on the session workspace only` });
  }
  if (argv.some((t) => !t || t.includes("\0"))) {
    return Promise.resolve({ ok: false, code: -1, stdout: "", stderr: "", blocked: "empty or NUL-containing argument" });
  }
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", argv, { cwd, env: gitEnv(), stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: "", stderr: String((e as Error).message ?? e), blocked: "spawn failed" });
      return;
    }
    const finish = (code: number, timedOut = false): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout: out, stderr: err, timedOut });
    };
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* уже мёртв */
      }
      finish(-1, true);
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      out += d;
      if (out.length > 4 * GIT_DIFF_MAX_BYTES) finish(-1, true); // защиты от горы вывода
    });
    child.stderr?.on("data", (d: string) => {
      err += d;
    });
    child.on("error", (e: Error) => {
      err += e.message;
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
  });
}

/** Один файл в дереве изменений (porcelain v1 -z). */
export interface GitFileStatus {
  path: string;
  /** XY[0] — индекс (staged). */
  index: string;
  /** XY[1] — рабочее дерево. */
  worktree: string;
  oldPath?: string;
}

/** Разбирает `status --porcelain=v1 -z --untracked-files=all`. */
export function parseStatusZ(stdout: string): GitFileStatus[] {
  const recs = stdout
    .split("\0")
    // Заголовок ветки (`## main...origin/main`) — не файл (приходит при `--branch`).
    .filter((r) => r.length >= 4 && !r.startsWith("## "));
  const files: GitFileStatus[] = [];
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    const index = rec[0];
    const worktree = rec[1];
    let path = rec.slice(3);
    if ((index === "R" || index === "C") && recs[i + 1]) {
      files.push({ path, index, worktree, oldPath: recs[++i] });
      path = recs[i];
      continue;
    }
    files.push({ path, index, worktree });
  }
  return files;
}

/** Заголовок ветки из `status -sb -z`: `## main...origin/main [ahead 1, behind 2]`. */
export function parseBranchHeader(stdout: string): {
  branch: string;
  detached: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
} {
  const head = stdout.split("\0")[0] ?? "";
  const m = head.match(/^##\s*(.*)$/);
  if (!m) return { branch: "", detached: false, ahead: 0, behind: 0 };
  let body = m[1].trim();
  let detached = false;
  let branch = "";
  if (body.startsWith("No commits yet on ")) {
    body = body.slice("No commits yet on ".length);
  } else if (body === "HEAD" || body.startsWith("HEAD (")) {
    detached = true;
    const at = body.match(/\(detached at ([^\s)]+)\)/);
    branch = at ? at[1].slice(0, 8) : "";
    body = body.replace(/^HEAD(\s*\([^)]*\))?/, "").trim();
  }
  let ahead = 0;
  let behind = 0;
  let gone = false;
  const stats = body.match(/\s*\[([^\]]*)\]$/);
  if (stats && stats.index !== undefined) {
    ahead = Number(stats[1].match(/ahead (\d+)/)?.[1] ?? 0);
    behind = Number(stats[1].match(/behind (\d+)/)?.[1] ?? 0);
    gone = /gone/.test(stats[1]);
    body = body.slice(0, stats.index).trim();
  }
  const [b, upstream] = body.split("...");
  branch = branch || (b ?? "").trim();
  return { branch, detached, upstream: upstream && !gone ? upstream.trim() : undefined, ahead, behind };
}

/** Разбирает `worktree list --porcelain -z`: путь, ветка, `bare`/`detached`. */
export function parseWorktreeList(stdout: string): { path: string; branch: string; head: string }[] {
  const out: { path: string; branch: string; head: string }[] = [];
  let cur: { path?: string; branch?: string; head?: string } = {};
  const flush = (): void => {
    if (cur.path) out.push({ path: cur.path, branch: cur.branch ?? "", head: cur.head ?? "" });
    cur = {};
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const m = line.match(/^(worktree|HEAD|branch|bare|detached)(?: (.*))?$/);
    if (!m) continue;
    if (m[1] === "worktree") {
      flush();
      cur.path = m[2] ?? "";
    } else if (m[1] === "HEAD") cur.head = m[2] ?? "";
    else if (m[1] === "branch") cur.branch = (m[2] ?? "").replace(/^refs\/heads\//, "");
    else if (m[1] === "detached") cur.branch = "";
    else if (m[1] === "bare") cur.branch = "(bare)";
  }
  flush();
  return out;
}

/** Теги на HEAD (`tag --points-at HEAD --list`, без значения-флага). */
export function parseTags(stdout: string): string[] {
  return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 10);
}

/** Подрезка diff до капа: строки → байты, с явным флагом усечения. */
export function capDiff(text: string, maxLines = GIT_DIFF_MAX_LINES, maxBytes = GIT_DIFF_MAX_BYTES): { diff: string; truncated: boolean } {
  const lines = text.split("\n");
  let out = text;
  let truncated = false;
  if (lines.length > maxLines) {
    out = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }
  const bytes = Buffer.byteLength(out, "utf8");
  if (bytes > maxBytes) {
    let cut = Math.floor(maxBytes * 0.8);
    while (cut > 0 && Buffer.byteLength(out.slice(0, cut), "utf8") > maxBytes) cut -= 1024;
    out = out.slice(0, Math.max(0, cut));
    truncated = true;
  }
  return { diff: out, truncated };
}

/** Снимок git-состояния workspace (чипы футера + вкладка изменений). */
export interface GitSnapshot {
  repo: boolean;
  reason?: string;
  branch?: string;
  detached?: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  dirty?: number;
  files?: GitFileStatus[];
  worktrees?: { path: string; branch: string; head: string }[];
  currentWorktree?: string;
  tags?: string[];
}

/**
 * Полный снимок за два вызова: `status -sb -z` (ветка+грязь+файлы) и
 * `worktree list --porcelain`. Вне репозитория — `repo:false`, не ошибка.
 */
export async function gitSnapshot(cwd: string, tags = true): Promise<GitSnapshot> {
  // Без `-c core.quotepath=false`: собственный jail-гейт запрещает `-c` и модели.
  // Не-ASCII пути останутся в кавычках octal — косметика, не потеря данных.
  const st = await runGit(cwd, ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"]);
  if (st.blocked) return { repo: false, reason: st.blocked };
  if (!st.ok) {
    const notRepo = /not a git repository|fatal:/.test(st.stderr);
    return { repo: false, reason: notRepo ? "not_a_repo" : st.stderr.trim().slice(0, 200) };
  }
  const header = parseBranchHeader(st.stdout);
  const files = parseStatusZ(st.stdout);
  const wt = await runGit(cwd, ["worktree", "list", "--porcelain"]);
  const worktrees = wt.ok ? parseWorktreeList(wt.stdout) : [];
  let tagList: string[] = [];
  if (tags) {
    const t = await runGit(cwd, ["tag", "--points-at", "HEAD", "--list"]);
    tagList = t.ok ? parseTags(t.stdout) : [];
  }
  return {
    repo: true,
    branch: header.branch,
    detached: header.detached,
    upstream: header.upstream,
    ahead: header.ahead,
    behind: header.behind,
    dirty: files.length,
    files,
    worktrees,
    currentWorktree: worktrees[0]?.path,
    tags: tagList,
  };
}

/** Проверка «это git-репозиторий?» для дешёвых путей (чипы без полной сборки). */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.stdout.trim() === "true";
}

/** Субкоманда argv (для логов и `data` тула). */
export function gitArgvSubcommand(argv: string[]): string {
  return gitSubcommand(argv);
}
