// Вотчер карты проекта на время жизни веб-хоста: `mma web` не гоняет сессию
// главного агента, поэтому REPL-хук плагина индексатора (`onSessionStart`) тут
// не срабатывает. Владельцем общего вотчера становится сам веб-UI. Best-effort:
// стаб без `watch`/`unwatch` (тесты, примеры) — no-op.
import type { WebIndexer } from "./host-state";

/** Узкий контракт вотчера: только подписка/отписка (без жёсткой зависимости). */
export interface WatchableIndexer {
  watch?(): void;
  unwatch?(): void;
}

/** Поднимает вотчер и возвращает функцию отписки. */
export function attachIndexWatcher(indexer?: WebIndexer): () => void {
  const target: WatchableIndexer | undefined = indexer;
  target?.watch?.();
  return () => target?.unwatch?.();
}
