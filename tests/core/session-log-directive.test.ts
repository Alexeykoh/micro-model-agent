/**
 * Честный `session.jsonl` (spec 2026-10-26-session-directive-log).
 *
 * В ses_mvpfzfg7 директива `narration` сработала (итерация 19), но в журнале
 * её не было: инъекции харнесса жили в контексте и в `app.jsonl`. Плюс канал
 * `type: "plan"` был занят предупреждениями execution-модуля. Гейт держит оба
 * свойства: «что модели сказали» пишется, а `plan` остаётся про план.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ContextManager } from "../../src/core/context/manager";
import { SessionLogger } from "../../src/core/session-logger";
import { SessionStore } from "../../src/modules/session/store";
import { SessionManager } from "../../src/modules/session/manager";
import type { SessionLogEntry } from "../../src/modules/session/store";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("sink инъекций харнесса", () => {
  it("отдаёт точный текст <system-summary> и ничего больше", () => {
    const seen: string[] = [];
    const cm = new ContextManager(100_000);
    cm.setHarnessSink((text) => seen.push(text));

    cm.addMessage({ role: "user", content: "<system-summary>скажи, что делаешь</system-summary>" });
    cm.addMessage({ role: "user", content: "обычный вопрос" });
    cm.addMessage({ role: "assistant", content: "<system-summary>это не инъекция</system-summary>" });

    expect(seen).toEqual(["<system-summary>скажи, что делаешь</system-summary>"]);
  });

  it("без sink молчит (обратная совместимость)", () => {
    const cm = new ContextManager(100_000);
    expect(() =>
      cm.addMessage({ role: "user", content: "<system-summary>x</system-summary>" }),
    ).not.toThrow();
  });
});

describe("событие directive в журнале сессии", () => {
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-directive-"));
    const store = new SessionStore(tmpDir);
    store.init();
    manager = new SessionManager(store, {
      model: "qwen/qwen3.5-9b",
      contextWindow: 32768,
      projectDir: "/test",
    });
    manager.create("s");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function readLogs(id: string): SessionLogEntry[] {
    const file = join(tmpDir, id, "session.jsonl");
    return readFileSync(file, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as SessionLogEntry);
  }

  it("пишет type=directive с каналом и итерацией", () => {
    const id = manager.getActive()!;
    const slog = new SessionLogger(manager, undefined, () => ({ provider: "p", model: "m" }));
    const text = "<system-summary>Ты не сказал пользователю ни слова</system-summary>";

    slog.logDirective("system_summary", text, 19);

    const entry = readLogs(id).find((l) => l.type === "directive")!;
    expect(entry.content).toBe(text);
    expect(entry.tool).toBe("system_summary");
    expect(entry.iteration).toBe(19);
  });

  it("канал plan не используется предупреждениями execution-модуля", () => {
    const dir = join(REPO_ROOT, "src", "modules", "execution");
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => {
        const src = readFileSync(join(dir, f), "utf-8");
        return /sessionLog\??\.plan\(\s*\n?\s*"(stuck-warning|web-search)"/.test(src);
      });
    expect(
      offenders,
      `Предупреждения execution-модуля должны идти в directive, а не в plan: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
