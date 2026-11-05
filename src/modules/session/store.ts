// Хранилище сессий: meta/history/session-лог на диске, шифрование, ротация в .gz.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "fs";
import { join } from "path";
import { gzipSync } from "zlib";
import type { SessionMeta, SessionMessage } from "./types";
import type { SessionEncryptionConfig } from "../../config/types";
import { SessionFileEncryptor } from "../security/session-encryption";
import { readHistoryFile, readRotatedHistory } from "./history-io";
import { appendLogEntry, readLogEntries, readLogEntriesResult } from "./log-file";
import { readCause, type SessionRead } from "./read-status";
import type { SessionLogEntry } from "./log-types";
import { SessionListCache } from "./list-cache";
export type { SessionLogEntry, OnboardingEvent } from "./log-types";

/** Файловое хранилище сессий: meta.json, history.jsonl, session.jsonl. */
export class SessionStore {
  private baseDir: string;
  private encryptor: SessionFileEncryptor | null = null;
  // In-memory кеш меты — иначе O(N²) чтений диска на appendMessage.
  private _metaCache = new Map<string, SessionMeta>();
  /** Кеш списка сессий и отрицательных мет (INV-W3, см. `list-cache.ts`). */
  private readonly listCache: SessionListCache;

  constructor(
    baseDir: string,
    encryptionConfig?: SessionEncryptionConfig,
    opts?: { cacheTtlMs?: number },
  ) {
    this.baseDir = baseDir;
    this.listCache = new SessionListCache(opts?.cacheTtlMs);
    if (encryptionConfig?.enabled) {
      this.encryptor = new SessionFileEncryptor(encryptionConfig);
    }
  }

  /** Каталог хранилища (нужен прунингу сирот, INV-W4). */
  baseDirPath(): string {
    return this.baseDir;
  }

  /** Каталог сессии по id. */
  getSessionDir(id: string): string {
    return join(this.baseDir, id);
  }

  /** Обновить конфиг шифрования. */
  updateEncryption(config: SessionEncryptionConfig): void {
    if (config?.enabled) {
      this.encryptor = new SessionFileEncryptor(config);
    } else {
      this.encryptor = null;
    }
  }

  /** Включено ли шифрование. */
  isEncryptionEnabled(): boolean {
    return this.encryptor?.isEnabled() ?? false;
  }

  /** Создать базовый каталог (0700). */
  init(): void {
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
  }

  private sessionDir(id: string): string {
    return join(this.baseDir, id);
  }

  private metaPath(id: string): string {
    return join(this.sessionDir(id), "meta.json");
  }

  private historyPath(id: string): string {
    return join(this.sessionDir(id), "history.jsonl");
  }

  private sessionLogPath(id: string): string {
    return join(this.sessionDir(id), "session.jsonl");
  }

  /** Хвост session-лога: последние строки для инкрементального чтения (Trace). */
  private sessionLogTailPath(id: string): string {
    return join(this.sessionDir(id), "session.log.tail");
  }

  /** Есть ли сессия (по meta.json). */
  sessionExists(id: string): boolean {
    return existsSync(this.metaPath(id));
  }

  /** Сохранить мету (кеш + диск 0600, опционально шифр). */
  saveMeta(id: string, meta: SessionMeta): void {
    this._metaCache.set(id, meta);
    this.listCache.forget(id);
    this.listCache.invalidate();
    const dir = this.sessionDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const content = JSON.stringify(meta, null, 2);
    if (this.encryptor) {
      writeFileSync(this.metaPath(id), this.encryptor.encryptFileContent(content), {
        encoding: "utf-8",
        mode: 0o600,
      });
    } else {
      writeFileSync(this.metaPath(id), content, { encoding: "utf-8", mode: 0o600 });
    }
  }

  /**
   * Загрузить мету (кеш, иначе диск); нет/битая — null. Отрицательный ответ
   * кешируется (INV-W3, `list-cache.ts`): каталогов на порядок больше, чем мет.
   */
  loadMeta(id: string): SessionMeta | null {
    const cached = this._metaCache.get(id);
    if (cached) return cached;
    const now = Date.now();
    if (this.listCache.missingSince(id, now)) return null;
    const path = this.metaPath(id);
    if (!existsSync(path)) {
      this.listCache.markMissing(id, now);
      return null;
    }
    try {
      const raw = readFileSync(path, "utf-8");
      const content = this.encryptor ? this.encryptor.decryptFileContent(raw) : raw;
      const meta = JSON.parse(content) as SessionMeta;
      this._metaCache.set(id, meta);
      this.listCache.forget(id);
      return meta;
    } catch {
      this.listCache.markMissing(id, now);
      return null;
    }
  }

  /**
   * Мета с различением «нет» и «не прочитана» (INV-15). Повреждённая мета
   * больше не выглядит как удалённая сессия: `list()` может пропустить её,
   * но потребитель с id получает причину.
   */
  loadMetaWithStatus(id: string): SessionRead<SessionMeta> {
    const cached = this._metaCache.get(id);
    if (cached) return { status: "ok", value: cached };
    const path = this.metaPath(id);
    if (!existsSync(path)) return { status: "missing" };
    try {
      const raw = readFileSync(path, "utf-8");
      const content = this.encryptor ? this.encryptor.decryptFileContent(raw) : raw;
      const meta = JSON.parse(content) as SessionMeta;
      this._metaCache.set(id, meta);
      this.listCache.forget(id);
      return { status: "ok", value: meta };
    } catch (err) {
      return { status: "unreadable", cause: readCause(err) };
    }
  }

  /** Мета строго с диска, мимо _metaCache (там, где важнее точность счётчика). */
  private readMetaFromDisk(id: string): SessionMeta | null {
    const path = this.metaPath(id);
    if (!existsSync(path)) return null;
    try {
      const raw = readFileSync(path, "utf-8");
      const content = this.encryptor ? this.encryptor.decryptFileContent(raw) : raw;
      return JSON.parse(content) as SessionMeta;
    } catch {
      return null;
    }
  }

  /** Добавить сообщение в историю; мету инкрементить с диска (защита от гонки процессов). */
  appendMessage(id: string, msg: SessionMessage): void {
    const dir = this.sessionDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify(msg);
    if (this.encryptor?.isEnabled()) {
      appendFileSync(this.historyPath(id), `${this.encryptor.encryptFileContent(line)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
    } else {
      appendFileSync(this.historyPath(id), `${line}\n`, { encoding: "utf-8", mode: 0o600 });
    }
    // Мету перечитываем с диска прямо перед инкрементом, чтобы счётчики
    // ДРУГОГО процесса не затирались протухшим in-memory снапшотом
    // (last-write-wins). Полноценные кросс-процессные локи вне скоупа;
    // это сужает окно гонки.
    const meta = this.readMetaFromDisk(id) ?? this._metaCache.get(id) ?? null;
    if (meta) {
      meta.messageCount = (meta.messageCount || 0) + 1;
      meta.updatedAt = msg.timestamp || new Date().toISOString();
      this.saveMeta(id, meta);
    }
  }

  /** Загрузить историю (битые строки пропускаются); нет файла — []. */
  loadHistory(id: string): SessionMessage[] {
    const enc = this.encryptor;
    const decrypt = enc?.isEnabled() ? (line: string) => enc.decryptFileContent(line) : undefined;
    return readHistoryFile(this.historyPath(id), decrypt);
  }

  /** История ротированной сессии из `<baseDir>/<id>.jsonl.gz`. Нет gz — []. */
  loadRotatedHistory(id: string): SessionMessage[] {
    return readRotatedHistory(join(this.baseDir, `${id}.jsonl.gz`));
  }

  /** Добавить запись в session-лог. */
  appendSessionLog(id: string, entry: SessionLogEntry): void {
    const dir = this.sessionDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendLogEntry(this.sessionLogPath(id), this.sessionLogTailPath(id), entry, this.encryptor);
  }

  /** Загрузить session-лог (битые строки пропускаются); нет файла — []. */
  loadSessionLog(id: string, opts: { since?: string } = {}): SessionLogEntry[] {
    // Инкрементальное чтение: с курсором берём только хвост (аудит §6.13).
    const path = opts.since ? this.sessionLogTailPath(id) : this.sessionLogPath(id);
    return readLogEntries(path, this.encryptor) ?? [];
  }

  /**
   * session-лог с различением «нет файла»/«не прочитан» (INV-15). `since`
   * сохраняет инкрементальный хвост; `truncated` — оборванная последняя строка.
   */
  loadSessionLogWithStatus(
    id: string,
    opts: { since?: string } = {},
  ): SessionRead<SessionLogEntry[]> {
    const path = opts.since ? this.sessionLogTailPath(id) : this.sessionLogPath(id);
    return readLogEntriesResult(path, this.encryptor);
  }

  /** Число каталогов сессий без чтения меты (дешёвый вход для автоочистки). */
  countSessions(): number {
    return existsSync(this.baseDir)
      ? readdirSync(this.baseDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length
      : 0;
  }
  /**
   * Список сессий по убыванию updatedAt (INV-W3). Скан кешируется
   * (`list-cache.ts`) и сбрасывается `saveMeta`/`deleteSession`; возвращается
   * копия — кешем управлять может только стор.
   */
  listSessions(): SessionMeta[] {
    const now = Date.now();
    const cached = this.listCache.peek(now);
    if (cached) return cached.slice();
    const sessions: SessionMeta[] = [];
    if (existsSync(this.baseDir)) {
      for (const entry of readdirSync(this.baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const meta = this.loadMeta(entry.name);
        if (meta) sessions.push(meta);
      }
      sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }
    this.listCache.remember(sessions, now);
    return sessions.slice();
  }

  /** Удалить сессию (кеш + каталог). */
  deleteSession(id: string): void {
    this._metaCache.delete(id);
    this.listCache.forget(id);
    this.listCache.invalidate();
    const dir = this.sessionDir(id);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Ротация: истории старше 30 дней — в .jsonl.gz, мета помечается rotated. */
  rotateOldSessions(): void {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const sessions = this.listSessions().slice();

    for (const session of sessions) {
      const updatedAt = new Date(session.updatedAt);
      if (updatedAt < thirtyDaysAgo) {
        const historyPath = this.historyPath(session.id);
        if (existsSync(historyPath)) {
          const content = readFileSync(historyPath, "utf-8");
          const compressed = gzipSync(content);
          const gzPath = join(this.baseDir, `${session.id}.jsonl.gz`);
          writeFileSync(gzPath, compressed);
          rmSync(historyPath);
          // Пометить мету, чтобы сессия не выглядела «живой» в списках —
          // иначе gz-сессия рекламирует messageCount > 0.
          const meta = this.loadMeta(session.id);
          if (meta) {
            meta.messageCount = 0;
            meta.rotated = true;
            this.saveMeta(session.id, meta);
          }
        }
      }
    }
  }
}
