import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { AppConfig } from "../../config/types";
import { SessionFileEncryptor } from "../security/session-encryption";
import type { ChangeEntry } from "./types";

export interface ChangesStoreDeps {
  sessionManager: { getSessionDirectory(id: string): string };
  getConfig: () => AppConfig;
}

export class ChangesStore {
  constructor(private readonly deps: ChangesStoreDeps) {}

  dir(sessionId: string): string {
    return join(this.deps.sessionManager.getSessionDirectory(sessionId), "changes");
  }

  private enc(): SessionFileEncryptor {
    return new SessionFileEncryptor(this.deps.getConfig().security?.sessionEncryption);
  }

  private index(sessionId: string): string {
    return join(this.dir(sessionId), "index.jsonl");
  }

  private state(sessionId: string): string {
    return join(this.dir(sessionId), "state.json");
  }

  private blob(sessionId: string, sha: string): string {
    return join(this.dir(sessionId), "blobs", sha.slice(0, 2), `${sha}.gz`);
  }

  private ensure(sessionId: string): void {
    mkdirSync(join(this.dir(sessionId), "blobs"), { recursive: true });
  }

  readEntries(sessionId: string): ChangeEntry[] {
    const file = this.index(sessionId);
    if (!existsSync(file)) return [];
    const lines = this.enc().decryptJSONL(
      readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean),
    );
    const out: ChangeEntry[] = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as ChangeEntry;
        if (e.v === 1 && typeof e.id === "string" && typeof e.op === "string") {
          out.push(e);
        }
      } catch {
        // Битая строка — пропуск, как в session.jsonl.
      }
    }
    return out;
  }

  append(sessionId: string, entry: ChangeEntry): void {
    this.ensure(sessionId);
    appendFileSync(
      this.index(sessionId),
      `${this.enc().encryptFileContent(JSON.stringify(entry))}\n`,
      "utf8",
    );
  }

  putBlob(sessionId: string, content: Buffer): string {
    const sha = createHash("sha256").update(content).digest("hex");
    const file = this.blob(sessionId, sha);
    if (!existsSync(file)) {
      this.ensure(sessionId);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(
        file,
        this.enc().encryptFileContent(gzipSync(content).toString("base64")),
        "utf8",
      );
    }
    return sha;
  }

  getBlob(sessionId: string, sha: string | null): Buffer | null {
    if (!sha) return null;
    const file = this.blob(sessionId, sha);
    if (!existsSync(file)) return null;
    const body = this.enc().decryptFileContent(readFileSync(file, "utf8"));
    return gunzipSync(Buffer.from(body, "base64"));
  }

  loadTurn(sessionId: string): number {
    const file = this.state(sessionId);
    if (!existsSync(file)) return 0;
    try {
      const raw = this.enc().decryptFileContent(readFileSync(file, "utf8"));
      const state = JSON.parse(raw) as { v: 1; turn: number };
      return state.v === 1 && Number.isInteger(state.turn) ? state.turn : 0;
    } catch {
      return 0;
    }
  }

  nextTurn(sessionId: string): number {
    const turn = this.loadTurn(sessionId) + 1;
    this.ensure(sessionId);
    const file = this.state(sessionId);
    const tmp = `${file}.tmp`;
    writeFileSync(
      tmp,
      this.enc().encryptFileContent(JSON.stringify({ v: 1, turn })),
      "utf8",
    );
    renameSync(tmp, file);
    return turn;
  }
}
