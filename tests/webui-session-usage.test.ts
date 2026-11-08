import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  saveSessionUsage,
  loadSessionUsage,
  usageFromLogEntries,
} from "../src/modules/webui/session/session-usage";
import { captureUsage } from "../src/core/host-state";
import { activeUsage, createWebUiState } from "../src/modules/webui/state";

describe("webui session usage persistence", () => {
  it("round-trips a usage snapshot through the session dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-usage-"));
    try {
      saveSessionUsage(dir, { contextUsed: 123, costUsd: 0.01 });
      expect(loadSessionUsage(dir)).toEqual({ contextUsed: 123, costUsd: 0.01 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("activeUsage lazily hydrates from disk after a reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-usage-"));
    try {
      saveSessionUsage(dir, { contextUsed: 42, contextLimit: 1000 });
      const s = createWebUiState();
      s.sessionManager = {
        list: () => [],
        get: () => null,
        getActive: () => "ses_p",
        setActive: () => {},
        delete: () => {},
        getSessionDirectory: () => dir,
      };
      // Factory mode: no global last-turn fallback, so disk is the only source.
      s.pool.setFactory(() => ({}) as never);

      expect(activeUsage(s, "ses_p")).toEqual({ contextUsed: 42, contextLimit: 1000 });
      expect(s.sessionUsage.ses_p).toEqual({ contextUsed: 42, contextLimit: 1000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("usageFromLogEntries aggregates llm_usage and ignores the rest", () => {
    expect(
      usageFromLogEntries([
        { type: "llm_usage", promptTokens: 100, completionTokens: 50, cachedTokens: 70 },
        { type: "assistant", promptTokens: 9999, completionTokens: 9999 },
        { type: "llm_usage", promptTokens: 200, completionTokens: 30 },
        { type: "llm_usage", promptTokens: "oops" },
      ]),
    ).toEqual({ promptTokensTotal: 300, completionTokensTotal: 80, cachedTokensTotal: 70 });
    // Кеш ни разу не отчитывался — поле опускается, как в captureUsage.
    expect(
      usageFromLogEntries([{ type: "llm_usage", promptTokens: 10, completionTokens: 5 }]),
    ).toEqual({ promptTokensTotal: 10, completionTokensTotal: 5 });
    expect(usageFromLogEntries([{ type: "context", promptTokens: 1 }])).toBeUndefined();
  });

  it("loadSessionUsage falls back to session.jsonl without web-usage.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-usage-"));
    try {
      // REPL-сессия: журнала вел REPL, web-usage.json не было (ses_mw88khb4).
      writeFileSync(
        join(dir, "session.jsonl"),
        [
          JSON.stringify({ type: "session_start", content: "session started" }),
          JSON.stringify({ type: "llm_usage", promptTokens: 10851, completionTokens: 544 }),
          "not-json{{{",
          JSON.stringify({ type: "llm_usage", promptTokens: 14878, completionTokens: 3042, cachedTokens: 14473 }),
          "",
        ].join("\n"),
        "utf-8",
      );
      expect(loadSessionUsage(dir)).toEqual({
        promptTokensTotal: 25729,
        completionTokensTotal: 3586,
        cachedTokensTotal: 14473,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadSessionUsage merges fallback totals into a legacy snapshot without them", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-usage-"));
    try {
      saveSessionUsage(dir, { contextUsed: 123, costUsd: 0.01 });
      writeFileSync(
        join(dir, "session.jsonl"),
        JSON.stringify({ type: "llm_usage", promptTokens: 1000, completionTokens: 250 }),
        "utf-8",
      );
      expect(loadSessionUsage(dir)).toEqual({
        contextUsed: 123,
        costUsd: 0.01,
        promptTokensTotal: 1000,
        completionTokensTotal: 250,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadSessionUsage keeps the higher of persisted and journal totals", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-usage-"));
    try {
      // web-usage.json покрывает только веб-эру (223010), журнал — всю жизнь
      // сессии (ses_mw88khb4): журнал выигрывает, счёт не убывает.
      saveSessionUsage(dir, {
        promptTokensTotal: 223010,
        completionTokensTotal: 10407,
        cachedTokensTotal: 168854,
      });
      writeFileSync(
        join(dir, "session.jsonl"),
        JSON.stringify({
          type: "llm_usage",
          promptTokens: 2760466,
          completionTokens: 55156,
          cachedTokens: 2513727,
        }),
        "utf-8",
      );
      expect(loadSessionUsage(dir)).toMatchObject({
        promptTokensTotal: 2760466,
        completionTokensTotal: 55156,
        cachedTokensTotal: 2513727,
      });
      // Журнал короче (рот/прунинг) — персист не гасится.
      writeFileSync(
        join(dir, "session.jsonl"),
        JSON.stringify({ type: "llm_usage", promptTokens: 10, completionTokens: 1 }),
        "utf-8",
      );
      expect(loadSessionUsage(dir)).toMatchObject({
        promptTokensTotal: 223010,
        completionTokensTotal: 10407,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("activeUsage aggregates via manager.loadSessionLog when the file is encrypted", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-usage-"));
    try {
      // Шифрованный session.jsonl сырым чтением не разбирается — тоталы берутся
      // из журнала менеджера (расшифровка внутри стора).
      writeFileSync(join(dir, "session.jsonl"), "salt:iv:tag:ciphertext", "utf-8");
      const s = createWebUiState();
      s.sessionManager = {
        list: () => [],
        get: () => null,
        getActive: () => "ses_enc",
        setActive: () => {},
        delete: () => {},
        getSessionDirectory: () => dir,
        loadSessionLog: () => [
          { type: "llm_usage", promptTokens: 122464, completionTokens: 5898, cachedTokens: 96196 } as never,
        ],
      };
      s.pool.setFactory(() => ({}) as never);
      expect(activeUsage(s, "ses_enc")).toEqual({
        promptTokensTotal: 122464,
        completionTokensTotal: 5898,
        cachedTokensTotal: 96196,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the next web turn accumulates on top of the fallback base, not from zero", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-usage-"));
    try {
      writeFileSync(
        join(dir, "session.jsonl"),
        JSON.stringify({ type: "llm_usage", promptTokens: 25729, completionTokens: 3586 }),
        "utf-8",
      );
      const base = loadSessionUsage(dir);
      const next = captureUsage(
        { success: true, text: "", iterationCount: 1, promptTokens: 500, completionTokens: 120 },
        32768,
        base,
      );
      expect(next).toMatchObject({ promptTokensTotal: 26229, completionTokensTotal: 3706 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when the session has no persisted snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-usage-"));
    try {
      const s = createWebUiState();
      s.sessionManager = {
        list: () => [],
        get: () => null,
        getActive: () => "ses_empty",
        setActive: () => {},
        delete: () => {},
        getSessionDirectory: () => dir,
      };
      s.pool.setFactory(() => ({}) as never);
      expect(activeUsage(s, "ses_empty")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
