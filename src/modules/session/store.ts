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
    | "audit";
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
}

export class SessionStore {
  private baseDir: string;
  private encryptor: SessionFileEncryptor | null = null;

  constructor(baseDir: string, encryptionConfig?: SessionEncryptionConfig) {
    this.baseDir = baseDir;
    if (encryptionConfig?.enabled) {
      this.encryptor = new SessionFileEncryptor(encryptionConfig);
    }
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
    mkdirSync(this.baseDir, { recursive: true });
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
    const dir = this.sessionDir(id);
    mkdirSync(dir, { recursive: true });
    const content = JSON.stringify(meta, null, 2);
    if (this.encryptor) {
      writeFileSync(this.metaPath(id), this.encryptor.encryptFileContent(content), "utf-8");
    } else {
      writeFileSync(this.metaPath(id), content, "utf-8");
    }
  }

  loadMeta(id: string): SessionMeta | null {
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
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(msg);
    if (this.encryptor?.isEnabled()) {
      appendFileSync(this.historyPath(id), this.encryptor.encryptFileContent(line) + "\n", "utf-8");
    } else {
      appendFileSync(this.historyPath(id), line + "\n", "utf-8");
    }
    const meta = this.loadMeta(id);
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
      if (this.encryptor?.isEnabled()) {
        const decryptedLines = lines.map(line => this.encryptor!.decryptFileContent(line));
        return decryptedLines.map((line) => JSON.parse(line) as SessionMessage);
      }
      return lines.map((line) => JSON.parse(line) as SessionMessage);
    } catch {
      return [];
    }
  }

  appendSessionLog(id: string, entry: SessionLogEntry): void {
    const dir = this.sessionDir(id);
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(entry);
    if (this.encryptor?.isEnabled()) {
      appendFileSync(
        this.sessionLogPath(id),
        this.encryptor.encryptFileContent(line) + "\n",
        "utf-8",
      );
    } else {
      appendFileSync(
        this.sessionLogPath(id),
        line + "\n",
        "utf-8",
      );
    }
  }

  loadSessionLog(id: string): SessionLogEntry[] {
    const path = this.sessionLogPath(id);
    if (!existsSync(path)) return [];
    try {
      const raw = readFileSync(path, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      if (this.encryptor?.isEnabled()) {
        const decryptedLines = lines.map(line => this.encryptor!.decryptFileContent(line));
        return decryptedLines.map((line) => JSON.parse(line) as SessionLogEntry);
      }
      return lines.map((line) => JSON.parse(line) as SessionLogEntry);
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
    sessions.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    return sessions;
  }

  deleteSession(id: string): void {
    const dir = this.sessionDir(id);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  rotateOldSessions(): void {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const sessions = this.listSessions();

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
        }
      }
    }
  }
}
