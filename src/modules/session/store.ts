// Хранилище сессий: meta/history/session-лог на диске, шифрование, ротация в .gz.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "fs";
import { join } from "path";
import { gzipSync, gunzipSync } from "zlib";
import type { SessionMeta, SessionMessage } from "./types";
import type { SessionEncryptionConfig } from "../../config/types";
import type { DiagnosticEvent, Source } from "../../output";
import type { EgressTurnSummary } from "../security/data-policy/types";
import { SessionFileEncryptor } from "../security/session-encryption";
import { appendLogTail } from "./log-tail";

/** События онбординга (`meet`/`init`) — явный союз вместо `onboarding_${string}` (W11). */
export type OnboardingEvent =
  | "onboarding_meet_start" | "onboarding_meet_done"
  | "onboarding_init_start" | "onboarding_init_done";

/** Запись session-журнала (инструменты, usage, critic, пробы и т.д.). */
export interface SessionLogEntry {
  ts: string;
  type:
    | "tool_call" | "tool_result" | "assistant" | "reasoning"
    | "user" | "system" | "error" | "compaction"
    | "tool_defs" | "audit" | "plan" | "context"
    | "llm_usage" | "session_start" | "baseline_typecheck"
    | "reasoning_control" | "context_probe" | "output"
    | "critic_check" | "critic_verdict" | "critic_escalation"
    | DiagnosticEvent | "claim_retry" | "service_task" | "egress_turn"
    | "egress_redacted"
    | OnboardingEvent;
  /**
   * Источник записи (INV-13), обязателен. `llm_usage` пишет origin отдельно:
   * provenance ≠ происхождение числа (W11).
   */
  source: Source;
  /**
   * Модуль-владелец записи (INV-13), без префикса `module:` — например `mcp`.
   */
  module?: string;
  tool?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  args?: Record<string, unknown>;
  content?: string;
  diff?: string;
  /** Ref'ы сохранённых изображений — тулов или пользователя (для web replay). */
  images?: import("./image-store").ToolImageRef[];
  success?: boolean;
  duration?: number;
  iteration?: number;
  contextTokens?: number;
  contextLimit?: number;
  toolCount?: number;
  toolNames?: string[];
  /** DLP-агрегат хода (`egress_turn`): классы/PII/назначение, без значений. */
  egress?: EgressTurnSummary;
  // Поля context-событий (снапшот / статистика итерации)
  window?: number;
  systemBudget?: number;
  reserveBudget?: number;
  historyBudget?: number;
  systemTokens?: number;
  toolTokens?: number;
  /** Сырая оценка контекста (аддитивное диагностическое поле). */
  estimatedTokensRaw?: number;
  /** Отношение actual/estimated калибратора (аддитивное поле context). */
  calibrationRatio?: number;
  /** Состояние калибратора: cold|warming|trusted|stale. */
  calibrationState?: string;
  quality?: number;
  messageCount?: number;
  compactionCount?: number;
  iterationsSinceCompaction?: number;
  blocks?: Array<{
    label: string;
    priority: string;
    tokens: number;
    included: boolean;
  }>;
  // Поля деталей компакции
  reason?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  qualityBefore?: number;
  qualityAfter?: number;
  messagesBefore?: number;
  messagesAfter?: number;
  removedTurns?: number;
  keptTurns?: number;
  summary?: string;
  /** Компакция: насколько упал объём (токены). Стадия — в `strategy`. */
  reducedBy?: number;
  // Поля llm_usage / провенанса
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Origin измерения/решения (`usage`: api|estimate), НЕ provenance записи. */
  origin?: string;
  durationMs?: number;
  /** Стабильность префикса промпта (0..1), client-side монитор кеша. */
  cacheStable?: number;
  /** Причина расхождения префикса: system/tools/history/volatile/none/unknown. */
  cacheCause?: string;
  /** Прочитано из кеша (cache read) за вызов. */
  cachedTokens?: number;
  /** Записано в кеш (cache write) за вызов. */
  cacheWriteTokens?: number;
  /** Источник кеш-данных: api | derived. */
  cacheSource?: string;
  // Поля session_start
  environment?: Record<string, unknown>;
  lspProbe?: {
    ok: Array<{ language: string; durationMs: number }>;
    failed: Array<{ language: string; error?: string; durationMs: number }>;
    noneApplicable: boolean;
  };
  plugins?: string[];
  skills?: number;
  // Поля baseline_typecheck
  passed?: boolean;
  message?: string;
  // Поля error (диагностика INV-14); provenance — общий `source` (INV-13).
  operation?: string;
  errorKind?: string;
  cause?: string;
  recoverable?: boolean;
  // Поля reasoning_control; `level` — заодно severity персистентных output-событий
  level?: string;
  strategy?: string;
  probePassed?: boolean;
  /** Класс claim-retry (success | artifact | output | repetition | …). */
  kind?: string;
  // Поля служебных событий (observability); subtaskId/expertTag/subtaskIds/
  // usageByTag больше не пишутся, но читаются в старых session.jsonl.
  title?: string;
  subtaskId?: string;
  expertTag?: string;
  status?: string;
  subtaskIds?: string[];
  cycle?: number;
  explanation?: string;
  decision?: string;
  usageByTag?: Record<
    string,
    { promptTokens: number; completionTokens: number; totalTokens: number; subtasks: number }
  >;
  // Поля service_task (Agent Service API v1): tenant/run-контекст (спека §10.3).
  tenantId?: string;
  principalId?: string;
  runId?: string;
  jobId?: string;
}

/** Файловое хранилище сессий: meta.json, history.jsonl, session.jsonl. */
export class SessionStore {
  private baseDir: string;
  private encryptor: SessionFileEncryptor | null = null;
  // In-memory кеш меты — иначе O(N²) чтений диска на appendMessage.
  private _metaCache = new Map<string, SessionMeta>();

  constructor(baseDir: string, encryptionConfig?: SessionEncryptionConfig) {
    this.baseDir = baseDir;
    if (encryptionConfig?.enabled) {
      this.encryptor = new SessionFileEncryptor(encryptionConfig);
    }
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

  /** Загрузить мету (кеш, иначе диск); нет/битая — null. */
  loadMeta(id: string): SessionMeta | null {
    const cached = this._metaCache.get(id);
    if (cached) return cached;
    const path = this.metaPath(id);
    if (!existsSync(path)) return null;
    try {
      const raw = readFileSync(path, "utf-8");
      const content = this.encryptor ? this.encryptor.decryptFileContent(raw) : raw;
      const meta = JSON.parse(content) as SessionMeta;
      this._metaCache.set(id, meta);
      return meta;
    } catch {
      return null;
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
    const path = this.historyPath(id);
    if (!existsSync(path)) return [];
    try {
      const raw = readFileSync(path, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      const parseLine = (line: string): SessionMessage | null => {
        try {
          return JSON.parse(line) as SessionMessage;
        } catch {
          return null;
        }
      };
      if (this.encryptor?.isEnabled()) {
        return lines
          .map((line) => {
            try {
              return this.encryptor!.decryptFileContent(line);
            } catch {
              return null;
            }
          })
          .filter((l): l is string => l !== null)
          .map(parseLine)
          .filter((m): m is SessionMessage => m !== null);
      }
      return lines.map(parseLine).filter((m): m is SessionMessage => m !== null);
    } catch {
      return [];
    }
  }

  /**
   * История ротированной сессии из `<baseDir>/<id>.jsonl.gz`. Нет gz — [].
   */
  loadRotatedHistory(id: string): SessionMessage[] {
    const gzPath = join(this.baseDir, `${id}.jsonl.gz`);
    if (!existsSync(gzPath)) return [];
    try {
      const content = gunzipSync(readFileSync(gzPath)).toString("utf-8");
      return content
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as SessionMessage;
          } catch {
            return null;
          }
        })
        .filter((m): m is SessionMessage => m !== null);
    } catch {
      return [];
    }
  }

  /** Добавить запись в session-лог. */
  appendSessionLog(id: string, entry: SessionLogEntry): void {
    const dir = this.sessionDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify(entry);
    const payload = this.encryptor?.isEnabled()
      ? `${this.encryptor.encryptFileContent(line)}\n`
      : `${line}\n`;
    appendFileSync(this.sessionLogPath(id), payload, { encoding: "utf-8", mode: 0o600 });
    // Хвост: последние строки лога отдельно — по нему Trace читает инкрементально
    // (аудит §6.13).
    appendLogTail(this.sessionLogTailPath(id), payload);
  }

  /** Загрузить session-лог (битые строки пропускаются); нет файла — []. */
  loadSessionLog(id: string, opts: { since?: string } = {}): SessionLogEntry[] {
    // Инкрементальное чтение: с курсором берём только хвост (аудит §6.13).
    const path = opts.since ? this.sessionLogTailPath(id) : this.sessionLogPath(id);
    if (!existsSync(path)) return [];
    try {
      const raw = readFileSync(path, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      const parseLine = (line: string): SessionLogEntry | null => {
        try {
          return JSON.parse(line) as SessionLogEntry;
        } catch {
          return null;
        }
      };
      if (this.encryptor?.isEnabled()) {
        return lines
          .map((line) => {
            try {
              return this.encryptor!.decryptFileContent(line);
            } catch {
              return null;
            }
          })
          .filter((l): l is string => l !== null)
          .map(parseLine)
          .filter((e): e is SessionLogEntry => e !== null);
      }
      return lines.map(parseLine).filter((e): e is SessionLogEntry => e !== null);
    } catch {
      return [];
    }
  }

  /** Список сессий по убыванию updatedAt. */
  listSessions(): SessionMeta[] {
    if (!existsSync(this.baseDir)) return [];
    const entries = readdirSync(this.baseDir, { withFileTypes: true });
    const sessions: SessionMeta[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const meta = this.loadMeta(entry.name);
        if (meta) sessions.push(meta);
      }
    }
    sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return sessions;
  }

  /** Удалить сессию (кеш + каталог). */
  deleteSession(id: string): void {
    this._metaCache.delete(id);
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
