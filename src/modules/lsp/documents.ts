// Синк документов и реестр диагностик одного LSP-соединения.
//
// Вынесено из `connection.ts` (правило 6): здесь только состояние документов и
// диагностик, транспорт и жизненный цикл процесса остаются в соединении.
import { readFileSync, statSync } from "fs";
import type {
  DiagnosticRecord,
  DocumentDiagnosticReport,
  DocumentState,
  PublishDiagnosticsParams,
} from "./connection-types";
import { fatalError } from "./connection-errors";
import { settleEmptyDiagnostics, waitForRecord, PROJECT_SETTLE_MS } from "./diagnostics-wait";
import type { LspDiagnostic } from "./types";
import { canonicalUri, uriToPath } from "./uri";

/** Отпечаток файла на диске: `mtimeMs:size`; undefined — файла нет/не file-URI. */
function diskStampOf(uri: string): string | undefined {
  try {
    const info = statSync(uriToPath(uri));
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return undefined;
  }
}

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
  /** Растёт на каждом фактическом `didOpen`/`didChange`. */
  private revision = 0;

  constructor(private readonly deps: DocumentStoreDeps) {}

  /** Забыть все документы и диагностики (новое соединение или teardown). */
  clear(): void {
    this.documents.clear();
    this.diagnostics.clear();
    this.revision = 0;
  }

  /** Открытые сейчас документы (для статуса UI). */
  openUris(): string[] {
    return [...this.documents.values()].filter((doc) => doc.open).map((doc) => doc.uri);
  }

  /** Показать серверу содержимое файла (didOpen или didChange-Full). */
  sync(uri: string, languageId: string, text: string): void {
    this.applySync(uri, languageId, text, false);
  }

  /**
   * Синк черновика pre-write проверки. Буфер помечается как черновик: если
   * запись заблокирована, `refreshFromDisk` вернёт серверу содержимое диска.
   */
  syncDraft(uri: string, languageId: string, text: string): void {
    this.applySync(uri, languageId, text, true);
  }

  private applySync(uri: string, languageId: string, text: string, draft: boolean): void {
    if (!this.deps.isOpen()) throw fatalError("LSP connection is not open");
    uri = canonicalUri(uri);
    const current = this.documents.get(uri);
    if (current?.open && current.text === text) {
      // Текст тот же, но файл мог быть перезаписан с тем же содержимым:
      // обновляем отпечаток, чтобы refresh не перечитывал его вечно.
      this.documents.set(uri, { ...current, draft, diskStamp: diskStampOf(uri) });
      this.deps.touch();
      return;
    }
    const diskStamp = diskStampOf(uri);
    if (!current?.open) {
      this.revision++;
      this.documents.set(uri, { uri, languageId, version: 1, text, open: true, diskStamp, draft });
      this.deps.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
      return;
    }
    this.revision++;
    const next: DocumentState = {
      ...current,
      version: current.version + 1,
      text,
      diskStamp,
      draft,
    };
    this.documents.set(uri, next);
    this.deps.notify("textDocument/didChange", {
      textDocument: { uri, version: next.version },
      contentChanges: [{ text }],
    });
    this.deps.touch();
  }

  /**
   * Перечитать открытые документы, изменённые на диске вне write-хуков
   * (`bash`, форматтер, git). LSP-сервер считает открытый буфер истиной и
   * игнорирует изменения файла на диске, поэтому без этого проверка любого
   * файла возвращала диагностики по устаревшим зависимостям.
   *
   * Возвращает true, если хотя бы один документ пересинкан.
   */
  refreshFromDisk(): boolean {
    if (!this.deps.isOpen()) return false;
    let changed = false;
    for (const [uri, doc] of [...this.documents]) {
      if (!doc.open) continue;
      const stamp = diskStampOf(uri);
      const externalChange = stamp !== undefined && stamp !== doc.diskStamp;
      // Черновик pre-write проверки перечитываем всегда: mtime диска не менялся,
      // если запись была заблокирована, но буфер сервера остался черновым.
      if (!externalChange && !doc.draft) continue;
      let text: string;
      try {
        text = readFileSync(uriToPath(uri), "utf-8");
      } catch {
        if (doc.draft) {
          this.close(uri);
          changed = true;
        }
        continue;
      }
      if (text === doc.text && !doc.draft) {
        this.documents.set(uri, { ...doc, diskStamp: stamp });
        continue;
      }
      this.sync(uri, doc.languageId, text);
      changed = true;
    }
    return changed;
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
    const record = this.diagnostics.get(uri);
    let diagnostics: LspDiagnostic[] | null;
    if (record && record.version === version) {
      if (record.validatedRevision < this.revision) {
        // Запись посчитана до правки другого файла. Сервер переопубликует
        // диагностику только затронутых файлов, поэтому ждём ограниченное окно:
        // не дождались — файл не затронут, прежняя запись остаётся верной.
        await waitForRecord(
          () => this.diagnostics.get(uri),
          version,
          Math.min(timeoutMs, PROJECT_SETTLE_MS),
          record,
        );
        this.validateAll();
      }
      diagnostics = this.diagnostics.get(uri)?.diagnostics ?? record.diagnostics;
    } else {
      diagnostics =
        (await waitForRecord(() => this.diagnostics.get(uri), version, timeoutMs))?.diagnostics ??
        null;
    }
    if (!diagnostics || diagnostics.length > 0) return diagnostics;
    return (await settleEmptyDiagnostics(() => this.diagnostics.get(uri), version)) ?? diagnostics;
  }

  /** После окна ожидания все принятые записи подтверждены на текущей ревизии. */
  private validateAll(): void {
    for (const [uri, record] of this.diagnostics) {
      this.diagnostics.set(uri, { ...record, validatedRevision: this.revision });
    }
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
    // DEBT(lsp-versionless-push): typescript-language-server не присылает
    // version, поэтому поздно пришедший пуш от старого текста нельзя отличить
    // от нового — он помечается текущей версией (см. docs/agents/debt.md).
    // Сохраняем ВЕРСИЮ, за которую сервер считал: текущая версия документа могла
    // уехать вперёд, и тогда диагностики помечались бы как свежие (аудит §8.3).
    const version = params.version ?? doc.version;
    this.diagnostics.set(uri, {
      version,
      revision: this.revision,
      validatedRevision: this.revision,
      diagnostics: params.diagnostics,
    });
    this.deps.touch();
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
    this.diagnostics.set(uri, {
      version,
      revision: this.revision,
      validatedRevision: this.revision,
      diagnostics: items,
    });
    this.deps.touch();
    return items;
  }
}
