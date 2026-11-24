import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { DEFAULTS } from "../../config/defaults";
import type { AppConfig } from "../../config/types";
import { SessionFileEncryptor } from "../security/session-encryption";
import {
  appendPrivateFile,
  ensurePrivateDirectory,
  writePrivateFileAtomic,
} from "./store-fs";
import {
  parseJournalLines,
  readChangeJournal,
} from "./journal";
import {
  InvalidTurnStateError,
  readTurnState,
  type TurnStateRead,
} from "./turn-state";
import {
  assertSha256,
  type ChangeEntry,
} from "./types";

export interface ChangesStoreDeps {
  sessionManager: { getSessionDirectory(id: string): string };
  getConfig: () => AppConfig;
}

export class ChangesStore {
  constructor(private readonly deps: ChangesStoreDeps) {}

  dir(sessionId: string): string {
    return join(this.deps.sessionManager.getSessionDirectory(sessionId), "changes");
  }

  private enc(): SessionFileEncryptor | null {
    const config = this.deps.getConfig().security?.sessionEncryption;
    return config?.enabled ? new SessionFileEncryptor(config) : null;
  }

  private encode(content: string): string {
    return this.enc()?.encryptFileContent(content) ?? content;
  }

  private decode(content: string): string {
    return this.enc()?.decryptFileContent(content) ?? content;
  }

  private decodeJSONL(lines: string[]): string[] {
    const encryptor = this.enc();
    return encryptor ? encryptor.decryptJSONL(lines) : lines;
  }

  private decodeJSONLStrict(lines: string[]): string[] {
    const encryptor = this.enc();
    if (!encryptor) return lines;
    return lines.map((line) => {
      try {
        return encryptor.decryptFileContent(line);
      } catch (error) {
        throw new Error("Unable to decrypt change journal line", { cause: error });
      }
    });
  }

  private index(sessionId: string): string {
    return join(this.dir(sessionId), "index.jsonl");
  }

  private state(sessionId: string): string {
    return join(this.dir(sessionId), "state.json");
  }

  private blob(sessionId: string, sha: string): string {
    assertSha256(sha);
    return join(this.dir(sessionId), "blobs", sha.slice(0, 2), `${sha}.gz`);
  }

  private ensure(sessionId: string): void {
    const dir = this.dir(sessionId);
    ensurePrivateDirectory(dir);
    ensurePrivateDirectory(join(dir, "blobs"));
  }

  private maxFileBytes(): number {
    const value = this.deps.getConfig().changes?.maxFileBytes;
    const fallback = DEFAULTS.changes!.maxFileBytes!;
    return value !== undefined && Number.isSafeInteger(value) && value > 0
      ? value
      : fallback;
  }

  readEntries(sessionId: string): ChangeEntry[] {
    const journal = readChangeJournal(this.index(sessionId));
    if (journal.status === "missing") return [];
    const lines = this.decodeJSONL(journal.lines.filter(Boolean));
    return parseJournalLines(lines, false, this.index(sessionId));
  }

  append(sessionId: string, entry: ChangeEntry): void {
    this.ensure(sessionId);
    appendPrivateFile(
      this.index(sessionId),
      `${this.encode(JSON.stringify(entry))}\n`,
    );
  }

  putBlob(sessionId: string, content: Buffer): string {
    const limit = this.maxFileBytes();
    if (content.byteLength > limit) {
      throw new Error(
        `Blob size ${content.byteLength} exceeds changes.maxFileBytes limit ${limit}`,
      );
    }
    const sha = createHash("sha256").update(content).digest("hex");
    const file = this.blob(sessionId, sha);
    this.ensure(sessionId);
    const shard = dirname(file);
    ensurePrivateDirectory(shard);
    if (existsSync(file)) {
      chmodSync(file, 0o600);
      try {
        if (this.readBlob(file, sha).equals(content)) return sha;
      } catch {
        // Existing content is corrupt or uses an old key: replace it atomically.
      }
    }
    writePrivateFileAtomic(
      file,
      this.encode(gzipSync(content).toString("base64")),
    );
    return sha;
  }

  getBlob(sessionId: string, sha: string | null): Buffer | null {
    if (sha === null) return null;
    const file = this.blob(sessionId, sha);
    if (!existsSync(file)) {
      throw new Error(`Missing blob ${sha} for session ${sessionId}`);
    }
    return this.readBlob(file, sha);
  }

  private readBlob(file: string, sha: string): Buffer {
    let raw: Buffer;
    try {
      const body = this.decode(readFileSync(file, "utf8"));
      raw = gunzipSync(Buffer.from(body, "base64"), {
        maxOutputLength: this.maxFileBytes(),
      });
    } catch (error) {
      throw new Error(
        `Corrupt blob ${sha}: decode failed or the per-file decompression limit was exceeded`,
        { cause: error },
      );
    }
    const actual = createHash("sha256").update(raw).digest("hex");
    if (actual !== sha) {
      throw new Error(
        `Blob integrity check failed for ${sha}: raw-content hash mismatch (${actual})`,
      );
    }
    return raw;
  }

  loadTurn(sessionId: string): number {
    const state = readTurnState(this.state(sessionId), (raw) => this.decode(raw));
    return state.status === "valid" ? state.turn : 0;
  }

  /** Single-writer allocation; atomic rename avoids partial state, not process races. */
  nextTurn(sessionId: string): number {
    let state: TurnStateRead;
    try {
      state = readTurnState(this.state(sessionId), (raw) => this.decode(raw));
    } catch (error) {
      if (!(error instanceof InvalidTurnStateError)) throw error;
      return this.recoverTurn(sessionId, error);
    }
    if (state.status === "valid") return this.allocateTurn(sessionId, state.turn);
    return this.recoverTurn(sessionId);
  }

  private recoverTurn(sessionId: string, stateCause?: unknown): number {
    const file = this.index(sessionId);
    const journal = readChangeJournal(file);
    if (journal.status === "missing") {
      if (stateCause) {
        throw new Error(
          `Cannot recover turn counter for session ${sessionId}: corrupt state and no journal`,
          { cause: stateCause },
        );
      }
      return this.allocateTurn(sessionId, 0);
    }
    if (journal.lines.length === 0) {
      throw new Error(
        `Cannot recover turn counter for session ${sessionId}: journal is empty`,
        { cause: stateCause },
      );
    }
    let lines: string[];
    try {
      lines = this.decodeJSONLStrict(journal.lines);
    } catch (error) {
      throw new Error(
        `Cannot recover turn counter for session ${sessionId}: undecryptable journal`,
        { cause: error },
      );
    }
    const entries = parseJournalLines(lines, true, file);
    const journalTurn = entries.reduce(
      (max, entry) => Math.max(max, entry.turn),
      0,
    );
    return this.allocateTurn(sessionId, journalTurn);
  }

  private allocateTurn(sessionId: string, previous: number): number {
    const turn = previous + 1;
    if (!Number.isSafeInteger(turn) || turn < 1) {
      throw new Error(`Turn counter overflow for session ${sessionId}`);
    }
    this.ensure(sessionId);
    writePrivateFileAtomic(
      this.state(sessionId),
      this.encode(JSON.stringify({ v: 1, turn })),
    );
    return turn;
  }
}
