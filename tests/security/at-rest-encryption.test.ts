/**
 * At-rest (opt-in): при включённом `sessionEncryption` ни `session.jsonl`, ни его
 * tail, ни history не содержат открытых секретов/PII; чтение через store их
 * возвращает. При выключенном — поведение не меняется (см. session-encryption).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SessionStore } from "../../src/modules/session/store";
import type { SessionEncryptionConfig } from "../../src/config/types";

const CANARY = "CANARY3e9b7c";
const SECRET = `sk-${CANARY}0123456789abcdef`;
const FIO = "Иванов Иван Иванович";
const ADDRESS = "ул. Ленина, д. 5, кв. 12";

function enabled(): SessionEncryptionConfig {
  return { enabled: true, encryptHistory: true, encryptSessionLog: true };
}

function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...allFiles(full));
    else out.push(full);
  }
  return out;
}

describe("at-rest: opt-in шифрование журнала", () => {
  it("секрет/PII не лежат открыто ни в одном файле сессии", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-atrest-"));
    try {
      const store = new SessionStore(dir, enabled());
      store.appendSessionLog("s1", {
        ts: new Date().toISOString(),
        type: "tool_result",
        source: "core",
        tool: "read_file",
        content: `body ${SECRET} ${FIO} ${ADDRESS}`,
      });
      store.appendMessage("s1", { role: "user", content: `paste ${SECRET}` });

      for (const file of allFiles(dir)) {
        const raw = readFileSync(file, "utf8");
        expect(raw, `plaintext in ${file}`).not.toContain(CANARY);
        expect(raw, `plaintext in ${file}`).not.toContain(FIO);
      }

      const logs = store.loadSessionLog("s1");
      expect(logs[0].content).toContain(CANARY);
      expect(store.loadHistory("s1")[0].content).toContain(CANARY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("выключенное шифрование оставляет прежнее поведение (контроль)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-atrest-off-"));
    try {
      const store = new SessionStore(dir, {
        enabled: false,
        encryptHistory: false,
        encryptSessionLog: false,
      });
      store.appendSessionLog("s2", {
        ts: new Date().toISOString(),
        type: "tool_result",
        source: "core",
        content: CANARY,
      });
      const raw = allFiles(dir)
        .map((f) => readFileSync(f, "utf8"))
        .join("\n");
      expect(raw).toContain(CANARY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
