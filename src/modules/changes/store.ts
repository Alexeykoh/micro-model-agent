import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { DEFAULTS } from "../../config/defaults";
import { globalMmaDir } from "../../config/paths";
import type { AppConfig } from "../../config/types";
import { SessionFileEncryptor } from "../security/session-encryption";
import {
  ensurePrivateDirectory,
  writePrivateFileAtomic,
} from "./store-fs";
import {
  assertSha256,
  type ChangeEntry,
  parseChangeEntry,
} from "./types";

export interface ChangesStoreDeps {
  sessionManager: { getSessionDirectory(id: string): string };
  getConfig: () => AppConfig;
}

export class ChangesStore {
  private encryptor?: { keyPath: string; value: SessionFileEncryptor };

  constructor(private readonly deps: ChangesStoreDeps) {}

  dir(sessionId: string): string {
    return join(this.deps.sessionManager.getSessionDirectory(sessionId), "changes");
  }

  private enc(): SessionFileEncryptor | null {
    const config = this.deps.getConfig().security?.sessionEncryption;
    if (!config?.enabled) return null;
    const keyPath =
      config.keyPath || join(globalMmaDir(), ".session-encryption-key");
    if (this.encryptor?.keyPath !== keyPath) {
      this.encryptor = {
        keyPath,
        value: new SessionFileEncryptor({ ...config, keyPath }),
      };
    }
    return this.encryptor.value;
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

  private blobLimit(): number {
    const changes = this.deps.getConfig().changes;
    const defaults = DEFAULTS.changes!;
    const maxFile = this.positiveLimit(changes?.maxFileBytes, defaults.maxFileBytes!);
    const maxTotal = this.positiveLimit(
      changes?.maxTotalBytes,
      defaults.maxTotalBytes!,
    );
    return Math.max(maxFile, maxTotal);
  }

  private positiveLimit(value: number | undefined, fallback: number): number {
    return value !== undefined && Number.isSafeInteger(value) && value > 0
      ? value
      : fallback;
  }

  readEntries(sessionId: string): ChangeEntry[] {
    const file = this.index(sessionId);
    if (!existsSync(file)) return [];
    const lines = this.decodeJSONL(
      readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean),
    );
    const out: ChangeEntry[] = [];
    for (const line of lines) {
      try {
        const entry = parseChangeEntry(JSON.parse(line));
        if (entry) out.push(entry);
      } catch {
        // Битая строка — пропуск, как в session.jsonl.
      }
    }
    return out;
  }

  append(sessionId: string, entry: ChangeEntry): void {
    this.ensure(sessionId);
    const file = this.index(sessionId);
    appendFileSync(
      file,
      `${this.encode(JSON.stringify(entry))}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    chmodSync(file, 0o600);
  }

  putBlob(sessionId: string, content: Buffer): string {
    const sha = createHash("sha256").update(content).digest("hex");
    const file = this.blob(sessionId, sha);
    this.ensure(sessionId);
    const shard = dirname(file);
    ensurePrivateDirectory(shard);
    if (!existsSync(file)) {
      writePrivateFileAtomic(
        file,
        this.encode(gzipSync(content).toString("base64")),
      );
    } else {
      chmodSync(file, 0o600);
    }
    return sha;
  }

  getBlob(sessionId: string, sha: string | null): Buffer | null {
    if (sha === null) return null;
    const file = this.blob(sessionId, sha);
    if (!existsSync(file)) {
      throw new Error(`Missing blob ${sha} for session ${sessionId}`);
    }
    let raw: Buffer;
    try {
      const body = this.decode(readFileSync(file, "utf8"));
      raw = gunzipSync(Buffer.from(body, "base64"), {
        maxOutputLength: this.blobLimit(),
      });
    } catch (error) {
      throw new Error(
        `Corrupt blob ${sha} for session ${sessionId}: decode failed or the decompression limit was exceeded`,
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
    const file = this.state(sessionId);
    if (!existsSync(file)) return 0;
    try {
      const value: unknown = JSON.parse(this.decode(readFileSync(file, "utf8")));
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Turn state must be an object");
      }
      const state = value as Record<string, unknown>;
      if (
        state.v !== 1 ||
        typeof state.turn !== "number" ||
        !Number.isSafeInteger(state.turn) ||
        state.turn < 0
      ) {
        throw new Error("Turn state requires v:1 and a safe non-negative turn");
      }
      return state.turn;
    } catch (error) {
      throw new Error(`Invalid or corrupt turn state for session ${sessionId}`, {
        cause: error,
      });
    }
  }

  /** Single-writer allocation; atomic rename avoids partial state, not process races. */
  nextTurn(sessionId: string): number {
    let stateTurn = 0;
    let stateInvalid = false;
    let stateCause: unknown;
    try {
      stateTurn = this.loadTurn(sessionId);
    } catch (error) {
      stateInvalid = true;
      stateCause = error;
    }
    const entries = this.readEntries(sessionId);
    const journalTurn = entries.reduce(
      (max, entry) => Math.max(max, entry.turn),
      0,
    );
    if (stateInvalid && entries.length === 0) {
      throw new Error(
        `Cannot recover turn counter for session ${sessionId}: corrupt state and no journal evidence`,
        { cause: stateCause },
      );
    }
    const turn = Math.max(stateTurn, journalTurn) + 1;
    if (!Number.isSafeInteger(turn) || turn < 0) {
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
