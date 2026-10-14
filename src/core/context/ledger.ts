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

/** Файл-леджер адресов с дедупом, cap-свёрткой и staleness. */
export class ContextLedger {
  private entries: LedgerEntry[] = [];
  private readonly byAddress = new Map<string, LedgerEntry>();
  private indexPath: string | null = null;

  constructor(
    private readonly filePath: string,
    private readonly max: number,
  ) {}

  /** Загружает существующий файл (idempotent). Формат строки: `address — note`. */
  load(): void {
    if (!existsSync(this.filePath)) return;
    for (const raw of readFileSync(this.filePath, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith(INDEX_PREFIX)) {
        this.indexPath = line.slice(INDEX_PREFIX.length).trim();
        continue;
      }
      const i = line.indexOf(SEP);
      if (i < 0) continue;
      const address = line.slice(0, i).trim();
      const stale = line.includes(STALE_MARK);
      const note = line.slice(i + SEP.length).replace(STALE_MARK, "").trim();
      // Last-wins: a later line for the same address supersedes the earlier one,
      // so note updates (and staleness marks) appended by `record`/`markStale`
      // are durable across reloads while still deduping to one entry per address.
      const existing = this.byAddress.get(address);
      if (existing) {
        existing.note = note;
        existing.stale = stale;
      } else {
        const e: LedgerEntry = { address, note, stale };
        this.entries.push(e);
        this.byAddress.set(address, e);
      }
    }
  }

  size(): number {
    return this.entries.length;
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
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${address}${SEP}${note}${stale ? STALE_MARK : ""}\n`, "utf8");
  }

  private enforceCap(): void {
    if (this.entries.length <= this.max) return;
    const overflow = this.entries.splice(0, this.entries.length - this.max);
    for (const e of overflow) this.byAddress.delete(e.address);
    const files = [...new Set(overflow.map((e) => e.address.split(":")[0]))];
    this.indexPath = `${files.join(", ")} (folded ${overflow.length})`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${INDEX_PREFIX} ${this.indexPath}\n`, "utf8");
  }
}
