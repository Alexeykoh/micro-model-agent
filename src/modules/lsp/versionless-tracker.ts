// Учёт push-диагностик без `version` (typescript-language-server).
//
// Сервер не присылает версию в `publishDiagnostics`, поэтому пуш, посчитанный
// на старом тексте, нельзя отличить по номеру. Единственный наблюдаемый
// признак гонки — версия документа ушла вперёд (`didChange`) между двумя
// пушами. Здесь считаем такие случаи и их замену, а также помечаем первый
// пуш как предварительный: `DocumentStore` даёт ему короткое окно на замену,
// но никогда не выбрасывает, если замены не было.
import type { LspClientLogger } from "./client-logger";

/** Счётчики гонки versionless-пушей за жизнь соединения. */
export interface VersionlessCounters {
  /** Пушей без version, пришедших после didChange этого документа. */
  afterChange: number;
  /** Из них заменённых следующим пушем. */
  replaced: number;
}

export interface VersionlessTrackerDeps {
  logger?: LspClientLogger | null;
  key?: string;
}

export interface PushVerdict {
  /** versionless-пуш пришёл после didChange — запись предварительная. */
  provisional: boolean;
  /** Ревизия, на которой запись ещё не подтверждена (для окна ожидания). */
  validatedRevision: number;
}

export class VersionlessTracker {
  private readonly lastSync = new Map<string, number>();
  private readonly lastPush = new Map<string, number>();
  private readonly counters: VersionlessCounters = { afterChange: 0, replaced: 0 };

  constructor(private readonly deps: VersionlessTrackerDeps) {}

  clear(): void {
    this.lastSync.clear();
    this.lastPush.clear();
    this.counters.afterChange = 0;
    this.counters.replaced = 0;
  }

  /** `didOpen`/`didChange` этого документа; глобальная ревизия уже увеличена. */
  noteSync(uri: string, revision: number): void {
    this.lastSync.set(uri, revision);
  }

  /**
   * Зафиксировать принятый пуш. `priorProvisional` — предыдущая запись этого
   * URI ждала замены. Счётчики пишутся в лог с нарастающим итогом: по ним
   * видно и частоту гонки, и долю замен без спекулятивного лечения.
   */
  notePush(uri: string, revision: number, versioned: boolean, priorProvisional: boolean): PushVerdict {
    const sync = this.lastSync.get(uri) ?? 0;
    const priorPush = this.lastPush.get(uri) ?? 0;
    const provisional = !versioned && sync > priorPush;
    const replaced = !versioned && priorProvisional;
    this.lastPush.set(uri, revision);
    if (replaced) this.counters.replaced++;
    if (provisional) {
      this.counters.afterChange++;
      this.log("LSP versionless push after didChange");
    }
    if (replaced) this.log("LSP versionless push replaced");
    return {
      provisional,
      validatedRevision: provisional ? priorPush : revision,
    };
  }

  snapshot(): VersionlessCounters {
    return { ...this.counters };
  }

  private log(msg: string): void {
    this.deps.logger?.warn(msg, { key: this.deps.key, ...this.snapshot() });
  }
}
