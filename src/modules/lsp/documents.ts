// Синк документов и реестр диагностик одного LSP-соединения.
//
// Вынесено из `connection.ts` (правило 6): здесь только состояние документов и
// диагностик, транспорт и жизненный цикл процесса остаются в соединении.
import type {
  DiagnosticRecord,
  DocumentDiagnosticReport,
  DocumentState,
  PublishDiagnosticsParams,
} from "./connection-types";
import { fatalError } from "./connection-errors";
import { settleEmptyDiagnostics, waitForRecord } from "./diagnostics-wait";
import type { LspDiagnostic } from "./types";
import { canonicalUri } from "./uri";

export interface DocumentStoreDeps {
  /** Соединение поднято и прошло `initialize`. */
  isOpen: () => boolean;
  /** Сервер объявил pull-модель диагностик. */
  supportsPull: () => boolean;
  /** Отправить запрос серверу (pull-диагностика). */
  request: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>;
  /** Отправить нотификацию серверу (`didOpen`/`didChange`/`didClose`). */
  notify: (method: string, params: unknown) => void;
  /** Отметить соединение использованным (idle/LRU). */
  touch: () => void;
}

export class DocumentStore {
  private readonly documents = new Map<string, DocumentState>();
  private readonly diagnostics = new Map<string, DiagnosticRecord>();

  constructor(private readonly deps: DocumentStoreDeps) {}

  /** Забыть все документы и диагностики (новое соединение или teardown). */
  clear(): void {
    this.documents.clear();
    this.diagnostics.clear();
  }

  /** Открытые сейчас документы (для статуса UI). */
  openUris(): string[] {
    return [...this.documents.values()].filter((doc) => doc.open).map((doc) => doc.uri);
  }

  /** Показать серверу содержимое файла (didOpen или didChange-Full). */
  sync(uri: string, languageId: string, text: string): void {
    if (!this.deps.isOpen()) throw fatalError("LSP connection is not open");
    uri = canonicalUri(uri);
    const current = this.documents.get(uri);
    if (current?.open && current.text === text) {
      this.deps.touch();
      return;
    }
    if (!current?.open) {
      this.documents.set(uri, { uri, languageId, version: 1, text, open: true });
      this.deps.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
      return;
    }
    const next: DocumentState = { ...current, version: current.version + 1, text };
    this.documents.set(uri, next);
    this.deps.notify("textDocument/didChange", {
      textDocument: { uri, version: next.version },
      contentChanges: [{ text }],
    });
    this.deps.touch();
  }

  /** `didClose` — парная к `didOpen` нотификация; чистит и диагностики. */
  close(uri: string): void {
    uri = canonicalUri(uri);
    const doc = this.documents.get(uri);
    if (!doc?.open || !this.deps.isOpen()) return;
    this.documents.set(uri, { ...doc, open: false });
    this.diagnostics.delete(uri);
    this.deps.notify("textDocument/didClose", { textDocument: { uri } });
    this.deps.touch();
  }

  /**
   * Диагностика документа. Возвращает:
   * - список (в т.ч. пустой) — это ответ сервера;
   * - `null` — сервер молчит (таймаут/нет push) — ответа нет, это не «чисто».
   */
  async diagnosticsFor(uri: string, timeoutMs: number): Promise<LspDiagnostic[] | null> {
    if (!this.deps.isOpen()) return null;
    uri = canonicalUri(uri);
    const doc = this.documents.get(uri);
    const version = doc?.version ?? -1;

    if (this.deps.supportsPull()) {
      const pulled = await this.pullDiagnostics(uri, version, timeoutMs);
      if (pulled) return pulled;
    }

    if (!doc?.open) return null;
    const diagnostics =
      this.freshDiagnostics(uri, version) ??
      (await waitForRecord(() => this.diagnostics.get(uri), version, timeoutMs))?.diagnostics ??
      null;
    if (!diagnostics || diagnostics.length > 0) return diagnostics;
    return (await settleEmptyDiagnostics(() => this.diagnostics.get(uri), version)) ?? diagnostics;
  }

  /** Актуальный список диагностик без ожидания (для быстрых путей). */
  peek(uri: string): DiagnosticRecord | null {
    return this.diagnostics.get(canonicalUri(uri)) ?? null;
  }

  /** Принять `textDocument/publishDiagnostics` (push-модель). */
  acceptDiagnostics(params: PublishDiagnosticsParams | undefined): void {
    if (!params?.uri || !Array.isArray(params.diagnostics)) return;
    // Сервер присылает свой вариант file-URI (`e%3A` vs `E:`): без канонизации
    // пуш не находил открытый документ и молча отбрасывался.
    const uri = canonicalUri(params.uri);
    const doc = this.documents.get(uri);
    if (!doc?.open) return;
    // Пуш от старой версии документа — игнор (антиретро-правки).
    if (params.version !== undefined && params.version < doc.version) return;
    // Сохраняем ВЕРСИЮ, за которую сервер считал: текущая версия документа могла
    // уехать вперёд, и тогда диагностики помечались бы как свежие (аудит §8.3).
    const version = params.version ?? doc.version;
    this.diagnostics.set(uri, { version, diagnostics: params.diagnostics });
    this.deps.touch();
  }

  /** Диагностики запрошенной версии; null — устаревших/нет (аудит §8.3). */
  private freshDiagnostics(uri: string, version: number): LspDiagnostic[] | null {
    const record = this.diagnostics.get(uri);
    return record && record.version === version ? record.diagnostics : null;
  }

  /** Pull-модель: явный `textDocument/diagnostic` (сервер объявил support). */
  private async pullDiagnostics(
    uri: string,
    version: number,
    timeoutMs: number,
  ): Promise<LspDiagnostic[] | null> {
    const report = (await this.deps
      .request("textDocument/diagnostic", { textDocument: { uri } }, timeoutMs)
      .catch(() => null)) as DocumentDiagnosticReport | null;
    if (report?.kind !== "full") return null;
    const items = report.items ?? [];
    this.diagnostics.set(uri, { version, diagnostics: items });
    this.deps.touch();
    return items;
  }
}
