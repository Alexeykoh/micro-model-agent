// Дебаунс-вотчер индексатора: подписка на изменения ФС и пересборка.
//
// Вынесен из `module.ts` (правило 6 AGENTS): lifecycle вотчера — отдельный шов
// от сборки индекса и его представления.

import type { Indexer } from "./walker";

/** Дебаунс между событием ФС и пересборкой индекса. */
const REBUILD_DEBOUNCE_MS = 2000;

/**
 * Подписка на изменения файлов с дебаунсом перестройки (best-effort).
 * `onSettled` зовётся после отреагировавшей пересборки (или её ошибки) —
 * веб-вкладка Files по нему перечитывает раскрытые папки.
 */
export class IndexWatch {
  /** Вотчер активен (для сайдбара). */
  active = false;

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly indexer: Indexer,
    private readonly rebuild: () => Promise<unknown>,
  ) {}

  start(onSettled?: () => void): void {
    this.stop();
    try {
      this.indexer.watch((_event, filename) => {
        if (!filename) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          void this.rebuild()
            .catch(() => {})
            .finally(() => onSettled?.());
        }, REBUILD_DEBOUNCE_MS);
      });
      this.active = true;
    } catch {
      // Вотчинг best-effort; ручной refresh всё равно работает.
    }
  }

  stop(): void {
    this.active = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.indexer.unwatch();
  }
}
