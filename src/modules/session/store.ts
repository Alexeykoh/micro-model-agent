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

export interface SessionLogEntry {
  ts: string;
  type:
    | "tool_call"
    | "tool_result"
    | "assistant"
    | "reasoning"
    | "user"
    | "system"
    | "error"
    | "compaction"
    | "tool_defs"
    | "audit"
    | "plan"
    | "context"
    | "llm_usage"
    | "session_start"
    | "baseline_typecheck"
    | "reasoning_control"
    | "context_probe"
    | "moe_plan"
    | "moe_subtask"
    | "moe_replan"
    | "moe_verify";
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
  success?: boolean;
  duration?: number;
  iteration?: number;
  contextTokens?: number;
  contextLimit?: number;
  toolCount?: number;
  toolNames?: string[];
  // context event fields (snapshot / per-iteration stats)
  window?: number;
  systemBudget?: number;
  reserveBudget?: number;
  historyBudget?: number;
  systemTokens?: number;
  toolTokens?: number;
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
  // compaction detail fields
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
  // llm_usage / provenance fields
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  source?: string;
  durationMs?: number;
  // session_start fields
  environment?: Record<string, unknown>;
  lspProbe?: {
    ok: Array<{ language: string; durationMs: number }>;
    failed: Array<{ language: string; error?: string; durationMs: number }>;
    noneApplicable: boolean;
  };
  plugins?: string[];
  skills?: number;
  // baseline_typecheck fields
  passed?: boolean;
  message?: string;
  // reasoning_control fields
  level?: string;
  strategy?: string;
  probePassed?: boolean;
  // moe_* event fields (Plan 4.2 observability)
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
}

export class SessionStore {
  private baseDir: string;
  private encryptor: SessionFileEncryptor | null = null;
  // In-memory meta cache to avoid O(N²) disk reads on appendMessage.
  private _metaCache = new Map<string, SessionMeta>();

  constructor(baseDir: string, encryptionConfig?: SessionEncryptionConfig) {
    this.baseDir = baseDir;
    if (encryptionConfig?.enabled) {
      this.encryptor = new SessionFileEncryptor(encryptionConfig);
    }
  }

  getSessionDir(id: string): string {
    return join(this.baseDir, id);
  }

  /**
   * Update encryption configuration
   */
  updateEncryption(config: SessionEncryptionConfig): void {
    if (config?.enabled) {
      this.encryptor = new SessionFileEncryptor(config);
    } else {
      this.encryptor = null;
    }
  }

  /**
   * Check if encryption is enabled
   */
  isEncryptionEnabled(): boolean {
    return this.encryptor?.isEnabled() ?? false;
  }

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

  sessionExists(id: string): boolean {
    return existsSync(this.metaPath(id));
  }

  saveMeta(id: string, meta: SessionMeta): void {
    this._metaCache.set(id, meta);
    const dir = this.sessionDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const content = JSON.stringify(meta, null, 2);
    if (this.encryptor) {
      writeFileSync(this.metaPath(id), this.encryptor.encryptFileContent(content), { encoding: "utf-8", mode: 0o600 });
    } else {
      writeFileSync(this.metaPath(id), content, { encoding: "utf-8", mode: 0o600 });
    }
  }

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

  /** Read meta straight from disk, bypassing _metaCache — used where counter
   *  accuracy matters more than read speed (see appendMessage). */
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

  appendMessage(id: string, msg: SessionMessage): void {
    const dir = this.sessionDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify(msg);
    if (this.encryptor?.isEnabled()) {
      appendFileSync(this.historyPath(id), this.encryptor.encryptFileContent(line) + "\n", { encoding: "utf-8", mode: 0o600 });
    } else {
      appendFileSync(this.historyPath(id), line + "\n", { encoding: "utf-8", mode: 0o600 });
    }
    // Re-read meta from disk (not the cache) right before the increment so
    // counters appended by ANOTHER process are not clobbered by a stale
    // in-memory snapshot (last-write-wins). Full cross-process locking is out
    // of scope; this narrows the race window.
    const meta = this.readMetaFromDisk(id) ?? this._metaCache.get(id) ?? null;
    if (meta) {
      meta.messageCount = (meta.messageCount || 0) + 1;
      meta.updatedAt = msg.timestamp || new Date().toISOString();
      this.saveMeta(id, meta);
    }
  }

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

  appendSessionLog(id: string, entry: SessionLogEntry): void {
    const dir = this.sessionDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify(entry);
    if (this.encryptor?.isEnabled()) {
      appendFileSync(
        this.sessionLogPath(id),
        this.encryptor.encryptFileContent(line) + "\n",
        { encoding: "utf-8", mode: 0o600 },
      );
    } else {
      appendFileSync(this.sessionLogPath(id), line + "\n", { encoding: "utf-8", mode: 0o600 });
    }
  }

  loadSessionLog(id: string): SessionLogEntry[] {
    const path = this.sessionLogPath(id);
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

  deleteSession(id: string): void {
    this._metaCache.delete(id);
    const dir = this.sessionDir(id);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

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
          // Mark the meta so the session stops looking "live" in lists —
          // otherwise a gzipped session still advertises messageCount > 0.
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
