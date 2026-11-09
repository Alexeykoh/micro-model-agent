/**
 * Egress-гейт для `git push` (спека `2026-11-09-git-push-egress-design`):
 * извлечение remote, нормализация URL, резолв и дифф незапушенных коммитов.
 * Выделено из `git-core.ts` (правило 6: ≤300 строк).
 */
import { runGit } from "./git-core";

/**
 * Извлекает remote из `git push [opts] [<remote> [<refspec>]]`: первый
 * не-опционный аргумент после `push`. Undefined — default remote.
 */
export function extractPushRemote(argv: string[]): string | undefined {
  const sub = argv[0]?.toLowerCase();
  if (sub !== "push" && sub !== "push-gate") return undefined;
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if (a === "--") return args[i + 1];
    if (a.startsWith("-")) {
      // Опции со значением: `=`-форма (`--opt=val`) или следующий токен для
      // известного списка. Остальные (`--force-with-lease`, `--tags`…) —
      // одиночные флаги, следующий токен может быть remote.
      const KNOWN_VALUE_OPTS = new Set(["--remote", "-o", "--push-option", "--receive-pack", "--exec", "--repo"]);
      if (!a.includes("=") && KNOWN_VALUE_OPTS.has(a) && i + 1 < args.length) i++;
      continue;
    }
    return a;
  }
  return undefined;
}

/** Нормализует git-remote URL к http(s) для outbound-проверки. */
export function normalizeGitRemoteUrl(raw: string): string {
  const url = raw.trim();
  // scp-подобная форма `git@host:path` → `https://host/`
  const scp = url.match(/^(?:[^@\s]+@)?([^:/\s]+):(.*)$/);
  if (/^(https?|ssh|git):\/\//i.test(url)) return url.replace(/^ssh:/i, "https:");
  if (scp && !url.includes("://")) return `https://${scp[1]}/`;
  return url;
}

/**
 * Резолвит URL push-адресата: явный URL как есть, имя — через
 * `git remote get-url <name>`. Undefined, если remote неизвестен (не fail-open).
 */
export async function resolvePushUrl(cwd: string, remote: string | undefined): Promise<string | undefined> {
  if (!remote) {
    const r = await runGit(cwd, ["remote"]);
    const names = r.ok ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
    const first = names[0];
    if (!first) return undefined;
    const u = await runGit(cwd, ["remote", "get-url", first]);
    return u.ok ? u.stdout.trim() : undefined;
  }
  if (/^(https?|ssh|git):\/\//i.test(remote) || remote.includes("@") || (remote.includes(":") && !remote.includes(" "))) {
    return normalizeGitRemoteUrl(remote);
  }
  const u = await runGit(cwd, ["remote", "get-url", remote]);
  return u.ok ? u.stdout.trim() : undefined;
}

/**
 * Дифф незапушенных коммитов (`merge-base...HEAD` против `@{push}` или
 * `origin/HEAD`). Пустой диапазон — пустая строка (сканировать нечего).
 */
export async function unpushedDiff(cwd: string): Promise<string> {
  const base = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "@{push}"]);
  let range = "";
  if (base.ok && base.stdout.trim()) {
    range = `${base.stdout.trim()}...HEAD`;
  } else {
    const head = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "origin/HEAD"]);
    if (head.ok && head.stdout.trim()) range = `${head.stdout.trim()}...HEAD`;
  }
  if (!range) return "";
  const d = await runGit(cwd, ["diff", "--no-color", range]);
  return d.ok ? d.stdout : "";
}
