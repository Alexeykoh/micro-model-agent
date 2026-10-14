// src/core/context/ledger.ts
// Durable леджер адресов (OO-3): `path:line — заметка`. Переживает любую
// компакцию; дедуп по адресу, cap со свёрткой старейших в индекс по файлам,
// пометка stale при изменении источника (OO-8). Без зависимости от модели и
// других модулей: только `node:fs` / `node:path` + память.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, relative } from "node:path";

export interface LedgerEntry {
  /** Адрес: `path:line`, `path:§heading`, `url#section`. */
  address: string;
  note: string;
  stale: boolean;
}

const STALE_MARK = " (stale)";
const INDEX_PREFIX = "[index]";
const SEP = " — ";

/** File-префикс адреса: `path:line|:charN|:§heading` → path; `url#section` → url. */
function filePrefix(address: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) return address.split("#")[0];
  return address.replace(/:(?:\d+|char\d+|§.*)$/, "");
}

/** Извлекает file-префиксы из строки индекса `f1.ts, f2.ts (folded N)`. */
function parseIndexFiles(indexLine: string): string[] {
  return indexLine
    .replace(/\(folded \d+\)/, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Файл-леджер адресов с дедупом, cap-свёрткой и staleness. */
export class ContextLedger {
  private entries: LedgerEntry[] = [];
  private readonly byAddress = new Map<string, LedgerEntry>();
  /** Накопительный индекс свёрнутых файлов (union, а не последняя пачка). */
  private readonly foldedFiles = new Set<string>();
  private indexPath: string | null = null;
  /**
   * Монотонный счётчик добавленных адресов. В отличие от `size()`, не
   * насыщается на `max` (cap сворачивает старейшие): пригоден как прогресс-прокси
   * «модель узнаёт новое» (см. `CompactionProgressTracker`).
   */
  private recordedTotal = 0;

  constructor(
    private readonly filePath: string,
    private readonly max: number,
  ) {}

  /** Загружает существующий файл (idempotent). Формат строки: `address — note`. */
  load(): void {
    if (!existsSync(this.filePath)) return;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      // FAIL-OPEN (INV-15): нечитаемый леджер не должен ронять ход.
      return;
    }
    // Перечитка состояния из файла: производные структуры восстанавливаются с нуля,
    // поэтому повторный load() на том же инстансе идемпотентен.
    this.entries = [];
    this.byAddress.clear();
    this.foldedFiles.clear();
    this.indexPath = null;

    for (const lineRaw of raw.split("\n")) {
      const line = lineRaw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith(INDEX_PREFIX)) {
        for (const f of parseIndexFiles(line.slice(INDEX_PREFIX.length).trim())) {
          this.foldedFiles.add(f);
        }
        continue;
      }
      const i = line.indexOf(SEP);
      if (i < 0) continue;
      const address = line.slice(0, i).trim();
      // Метка stale — только суффикс строки; заметка, содержащая `(stale)` внутри,
      // не должна читаться как помеченная.
      const marked = line.endsWith(STALE_MARK);
      const body = marked ? line.slice(0, -STALE_MARK.length) : line;
      const note = body.slice(i + SEP.length).trim();
      // Last-wins: a later line for the same address supersedes the earlier one,
      // so note updates (and staleness marks) appended by `record`/`markStale`
      // are durable across reloads while still deduping to one entry per address.
      const existing = this.byAddress.get(address);
      if (existing) {
        existing.note = note;
        existing.stale = marked;
      } else {
        const e: LedgerEntry = { address, note, stale: marked };
        this.entries.push(e);
        this.byAddress.set(address, e);
      }
    }
    // The file is append-only and survives across sessions, so re-apply the cap
    // in memory only (no rewrite, no extra `[index]` line): drop the oldest
    // entries beyond `max` and merge their file prefixes into the fold index.
    if (this.entries.length > this.max) {
      this.fold(this.entries.splice(0, this.entries.length - this.max));
    }
    this.refreshIndex();
  }

  size(): number {
    return this.entries.length;
  }

  /**
   * Монотонно растущий счётчик добавленных адресов (не насыщается на cap).
   * Дедуп/обновление заметки существующего адреса счётчик не двигает — иначе
   * повторное чтение того же источника выглядело бы как прогресс.
   */
  totalRecorded(): number {
    return this.recordedTotal;
  }

  /** Добавляет адрес (дедуп по адресу; повтор обновляет заметку) и персистит. */
  record(address: string, note: string): void {
    const existing = this.byAddress.get(address);
    if (existing) {
      if (existing.note !== note) {
        existing.note = note;
        this.persistLine(address, note, existing.stale);
      }
      return;
    }
    const e: LedgerEntry = { address, note, stale: false };
    this.entries.push(e);
    this.byAddress.set(address, e);
    // Новый адрес (не дедуп/не обновление заметки) — прогресс.
    this.recordedTotal++;
    this.persistLine(address, note, false);
    this.enforceCap();
  }

  /** OO-8: пометить адреса файла stale (сам путь и всё под ним). Персистит метку. */
  markStale(pathPrefix: string): void {
    for (const e of this.entries) {
      if ((e.address === pathPrefix || e.address.startsWith(`${pathPrefix}:`)) && !e.stale) {
        e.stale = true;
        this.persistLine(e.address, e.note, true);
      }
    }
  }

  isStale(address: string): boolean {
    return this.byAddress.get(address)?.stale ?? false;
  }

  /** Строка-указатель для блока компакции: `[Notes: <shortPath>, N]`. */
  pointerLine(): string {
    return this.entries.length === 0 ? "" : `[Notes: ${this.shortPath()}, ${this.entries.length}]`;
  }

  /** Рендер леджера для модели: `address — note[(stale)]`, плюс `[index] ...`. */
  render(): string {
    const lines = this.entries.map(
      (e) => `${e.address}${SEP}${e.note}${e.stale ? STALE_MARK : ""}`,
    );
    if (this.indexPath) lines.push(`${INDEX_PREFIX} ${this.indexPath}`);
    return lines.join("\n");
  }

  private shortPath(): string {
    try {
      return relative(process.cwd(), this.filePath) || this.filePath;
    } catch {
      return this.filePath;
    }
  }

  private persistLine(address: string, note: string, stale: boolean): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${address}${SEP}${note}${stale ? STALE_MARK : ""}\n`, "utf8");
    } catch {
      // FAIL-OPEN (INV-15). DEBT(ledger-write-diagnostics): провал записи
      // (read-only/ENOSPC/права) проглатывается — в памяти запись уже есть,
      // файл просто отстаёт; ход и компакция не должны падать.
    }
  }

  /** Сворачивает вытесненные записи: их file-префиксы копятся в union-индекс. */
  private fold(overflow: LedgerEntry[]): void {
    for (const e of overflow) {
      this.byAddress.delete(e.address);
      this.foldedFiles.add(filePrefix(e.address));
    }
  }

  private refreshIndex(): void {
    this.indexPath = this.foldedFiles.size ? [...this.foldedFiles].join(", ") : null;
  }

  private enforceCap(): void {
    if (this.entries.length <= this.max) return;
    const overflow = this.entries.splice(0, this.entries.length - this.max);
    this.fold(overflow);
    this.refreshIndex();
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${INDEX_PREFIX} ${this.indexPath ?? ""}\n`, "utf8");
    } catch {
      // FAIL-OPEN (INV-15). DEBT(ledger-write-diagnostics): индекс-свёртка не
      // записана, но в памяти она уже применена (см. persistLine).
    }
  }
}
