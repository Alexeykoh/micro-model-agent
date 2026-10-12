// Трекер консистентности: решения агента, созданные и удалённые файлы.
/** Отслеживаемое решение: текст + где принято. */
export interface TrackedDecision {
  decision: string;
  location: string;
}

/** Проверка консистентности: решения, созданные/удалённые файлы сессии. */
export class ConsistencyCheck {
  private decisions: TrackedDecision[] = [];
  private createdFiles: Set<string> = new Set();
  private deletedFiles: Set<string> = new Set();

  /** Запоминает решение агента. */
  trackDecision(decision: string, location: string): void {
    this.decisions.push({ decision, location });
  }

  /** Отмечает созданный файл (снимает с него флаг удалённого). */
  trackCreatedFile(path: string): void {
    this.createdFiles.add(path);
    // Удаление с последующим пересозданием снимает флаг — иначе wasFileDeleted()
    // считает файл пропавшим и после delete+create.
    this.deletedFiles.delete(path);
  }

  /** Отмечает удалённый файл. */
  trackDeletedFile(path: string): void {
    this.deletedFiles.add(path);
  }

  /** Все созданные файлы. */
  getCreatedFiles(): string[] {
    return Array.from(this.createdFiles);
  }

  /** Все удалённые файлы. */
  getDeletedFiles(): string[] {
    return Array.from(this.deletedFiles);
  }

  /** Все отслеживаемые решения. */
  getDecisions(): TrackedDecision[] {
    return this.decisions;
  }

  /** True, если есть хоть одно решение. */
  hasDecisions(): boolean {
    return this.decisions.length > 0;
  }
}
