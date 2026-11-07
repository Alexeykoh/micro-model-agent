// Базовая ветка текущей ветки (для чипа футера `⎇ base → branch`).
//
// Официального понятия «от какой ветки отпочкована» в git нет; честный
// источник — запись создания в reflog самой ветки:
//   • `branch: Created from <ref>`        (`git branch feat main`, `git switch -c feat main`)
//   • `branch: Created from HEAD`          (`git checkout -b feat`) — здесь HEAD безымянный,
//     берём самую СТАРУЮ строку `checkout: moving from <X> to feat` из reflog HEAD:
//     позднейшие навигационные переходы в feat старше неё не бывают.
// Всё, что не читается (detached, squashed-история, удалённый reflog), — пусто:
// чип остаётся просто `⎇ feat`, молча и без выдумывания.
//
// Цепочка (`main → dev → feat`) строится рекурсивно с капом глубины и
// защитой от цикла; результат мемоизируется на кеш снимков — reflog создания
// ветки неизменен, переспрашивать git каждый тик незачем.
import { runGit } from "../../../tools/git-core";

/** Кап длины цепочки предков (щит от аномальных reflog-петель). */
export const BASE_CHAIN_MAX = 6;
/** Сколько последних записей reflog ветки читаем (запись создания — самая старая из них). */
const REFLOG_TAIL = 20;
/** То же для HEAD: строка создания попадает в хвост даже на активном репозитории. */
const HEAD_REFLOG_TAIL = 200;

/** `refs/heads/main` → `main`, `refs/remotes/origin/main` → `origin/main`. */
export function normalizeRef(raw: string): string {
  return raw
    .trim()
    .replace(/^refs\/(heads|remotes|tags)\//, "")
    .replace(/[\^~]\d*$/, "");
}

/**
 * Из subject-строк reflog ветки (свежие первыми) — родитель при создании.
 * `HEAD` как «из чего» возвращаем как есть: вызывающий разрешает его через
 * reflog HEAD.
 */
export function parseCreatedFrom(subjects: string[]): string {
  for (let i = subjects.length - 1; i >= 0; i--) {
    const m = /^branch: Created from (\S+)$/.exec(subjects[i] ?? "");
    if (m) return normalizeRef(m[1]);
  }
  return "";
}

/**
 * Из subject-строк reflog HEAD (свежие первыми): самая СТАРАЯ строка
 * `checkout: moving from X to <branch>` — это момент создания ветки.
 */
export function parseCheckoutFrom(subjects: string[], branch: string): string {
  for (let i = subjects.length - 1; i >= 0; i--) {
    const m = /^checkout: moving from (\S+) to (\S+)$/.exec(subjects[i] ?? "");
    if (m && normalizeRef(m[2]) === normalizeRef(branch)) return normalizeRef(m[1]);
  }
  return "";
}

function subjectsOf(stdout: string): string[] {
  return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Непосредственный родитель ветки: "" — неизвестно/не-ветка. Мемо (может быть
 * передан из кеша снимков) не плодит повторных git-вызовов на тик.
 */
export async function directBase(
  cwd: string,
  branch: string,
  memo?: Map<string, string>,
): Promise<string> {
  const name = normalizeRef(branch);
  if (!name) return "";
  if (memo?.has(name)) return memo.get(name) ?? "";
  let base = "";
  const own = await runGit(cwd, ["reflog", "show", "--format=%gs", `-${REFLOG_TAIL}`, name]);
  if (own.ok) {
    const created = parseCreatedFrom(subjectsOf(own.stdout));
    if (created && created !== "HEAD") base = created;
    else if (created === "HEAD") {
      const head = await runGit(cwd, ["reflog", "show", "--format=%gs", `-${HEAD_REFLOG_TAIL}`, "HEAD"]);
      if (head.ok) base = parseCheckoutFrom(subjectsOf(head.stdout), name);
    }
  }
  memo?.set(name, base);
  return base;
}

/**
 * Цепочка предков от корня к текущей: `["main", "dev"]` для `feat` (main→dev→feat).
 * Пустой массив — неизвестно. Удалённый ref (`origin/main`) цепочку завершает:
 * вглубь remotes не идём.
 */
export async function baseChain(
  cwd: string,
  branch: string,
  memo?: Map<string, string>,
): Promise<string[]> {
  const chain: string[] = [];
  const seen = new Set<string>([normalizeRef(branch)]);
  let cur = normalizeRef(branch);
  while (cur && chain.length < BASE_CHAIN_MAX) {
    const b = await directBase(cwd, cur, memo);
    if (!b || seen.has(b)) break;
    seen.add(b);
    chain.push(b);
    cur = b;
    // Remote-tracking — конец цепочки (своей истории reflog у него нет).
    if (b.includes("/") && !b.startsWith("heads/")) break;
  }
  return chain.reverse();
}
