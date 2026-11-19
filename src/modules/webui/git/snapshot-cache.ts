// Серверный кеш git-снимка для веба (спека git-workflow §6.1/§8).
//
// `buildHostState` синхронный — в горячем пути (каждый тик SSE) git не
// исполняется: здесь последний снимок, а обновление — по TTL и по росту
// `filesRevision` (инвалидация вотчером). Поллинга git нет.
import { gitSnapshot, GIT_SNAPSHOT_TTL_MS, type GitSnapshot } from "../../../tools/git-core";
import { baseChain } from "./base-branch";

/**
 * Снимок для веба: к `git-core`-снимку добавлена цепочка базовых веток
 * (`base` — непосредственный родитель, `chain` — путь от корня). Считается
 * один раз на имя ветки (запись создания в reflog неизменна) и живёт в `memo`.
 */
export type WebGitSnapshot = GitSnapshot & { base?: string; chain?: string[] };

export interface GitCacheState {
  snapshot: WebGitSnapshot | null;
  /** Момент последней успешной сборки (epoch ms). */
  builtAt: number;
  /** `filesRevision` на момент сборки — рост инвалидирует снимок. */
  rev: number;
  /** Полёт single-flight: параллельные вызовы ждут одну сборку. */
  inflight: Promise<GitSnapshot> | null;
  /** Мемо `ветка → родитель` между пересборками (git-вызовы не повторяем). */
  baseMemo: Map<string, string>;
}

/** Пустой кеш (стабы тестов создают его литералом). */
export function createGitCache(): GitCacheState {
  return { snapshot: null, builtAt: 0, rev: -1, inflight: null, baseMemo: new Map() };
}

/**
 * Обогатить снимок цепочкой предков. Fail-open: любой сбой/неизвестность —
 * прежний снимок без `base` (чип остаётся `⎇ branch`, молча).
 */
async function withBase(
  cwd: string,
  snap: GitSnapshot,
  memo: Map<string, string>,
): Promise<WebGitSnapshot> {
  if (!snap.repo || !snap.branch || snap.detached) return snap;
  try {
    const chain = await baseChain(cwd, snap.branch, memo);
    if (!chain.length) return snap;
    return { ...snap, base: chain[chain.length - 1], chain };
  } catch {
    return snap;
  }
}

/**
 * Возвращает снимок из кеша, при протухании — пересобирает в фоне и отдаёт
 * прежний (chips переключат DOM по подписи, когда придёт новый). Первый
 * вызов ждёт сборку: без снимка чипам рисовать нечего.
 */
export async function gitSnapshotCached(cache: GitCacheState, cwd: string, rev: number): Promise<GitSnapshot | null> {
  const stale =
    cache.snapshot === null ||
    rev !== cache.rev ||
    Date.now() - cache.builtAt > GIT_SNAPSHOT_TTL_MS;
  if (!stale) return cache.snapshot;
  if (!cache.inflight) {
    cache.inflight = gitSnapshot(cwd)
      .then((snap) => withBase(cwd, snap, cache.baseMemo))
      .then((snap) => {
        cache.snapshot = snap;
        cache.builtAt = Date.now();
        cache.rev = rev;
        return snap;
      })
      .finally(() => {
        cache.inflight = null;
      });
  }
  // Первый снимок — ждём; инвалидация — отдаём прежний, пусть добирает фон.
  if (cache.snapshot === null) return await cache.inflight;
  void cache.inflight;
  return cache.snapshot;
}

/** Инвалидация по внешнему сигналу (вотчер): следующий читатель пересоберёт. */
export function invalidateGitCache(cache: GitCacheState): void {
  cache.builtAt = 0;
}

/**
 * Синхронный «peek» для `buildHostState`: отдаёт последний снимок и, если он
 * протух, запускает пересборку в фоне (по готовности — `onUpdated`, чтобы
 * хост пушнул SSE `state` и чипы обновились без перезагрузки).
 *
 * Вне репозитория TTL не действует: повторная сборка только по росту `rev`,
 * иначе в workspace без git git зомби-поллился бы каждые 5 с (§8 спеки).
 */
export function gitPeek(
  cache: GitCacheState,
  cwd: string,
  rev: number,
  onUpdated?: (snap: GitSnapshot) => void,
): GitSnapshot | null {
  const repo = cache.snapshot?.repo === true;
  const stale =
    cache.snapshot === null ||
    rev !== cache.rev ||
    (repo && Date.now() - cache.builtAt > GIT_SNAPSHOT_TTL_MS);
  if (stale && !cache.inflight) {
    cache.inflight = gitSnapshot(cwd)
      .then((snap) => withBase(cwd, snap, cache.baseMemo))
      .then((snap) => {
        cache.snapshot = snap;
        cache.builtAt = Date.now();
        cache.rev = rev;
        onUpdated?.(snap);
        return snap;
      })
      .finally(() => {
        cache.inflight = null;
      });
    // Первый снимок ещё не собран — фоном, без await в горячем пути.
    void cache.inflight;
  }
  return cache.snapshot;
}
