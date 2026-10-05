// Хардненинг оценки контекста: инвалидация кэша, калибровка, safety-clamp.
import { describe, it, expect } from "vitest";
import { ContextManager } from "../src/modules/context/manager";

describe("ContextManager estimate hardening", () => {
  it("recomputes a message's estimate when its content is mutated in place", () => {
    const mgr = new ContextManager(100000);
    const msg = { role: "user" as const, content: "hello" };
    mgr.addMessage(msg);
    const before = mgr.getEstimatedTokens();
    // In-place мутация (второй класс первопричины +44K): сигнатура меняется.
    msg.content = "x".repeat(100000);
    const after = mgr.getEstimatedTokens();
    expect(after).toBeGreaterThan(before + 10000);
  });

  it("does not jump estimate when two small messages are added", () => {
    const mgr = new ContextManager(34048);
    mgr.addMessage({ role: "user", content: "task" });
    for (let i = 0; i < 20; i++) {
      mgr.addMessage({ role: "assistant", content: `step ${i} ok` });
    }
    const before = mgr.getEstimatedTokens();
    mgr.addMessage({ role: "assistant", content: "one" });
    mgr.addMessage({ role: "tool", content: "two", name: "read_file" });
    const after = mgr.getEstimatedTokens();
    // 2 маленьких сообщения не могут дать скачок в десятки тысяч токенов.
    expect(after - before).toBeLessThan(2000);
  });

  it("getContextTokens calibrates down once trusted", () => {
    const mgr = new ContextManager(100000);
    mgr.addMessage({ role: "user", content: "a".repeat(1000) });
    const raw = mgr.getEstimatedTokens();
    for (let i = 0; i < 3; i++) {
      mgr.calibrate(Math.floor(raw * 0.9), raw, mgr.getMessageCount());
    }
    expect(mgr.getEstimateDiagnostics().state).toBe("trusted");
    expect(mgr.getContextTokens()).toBeLessThan(raw);
    expect(mgr.getContextTokens()).toBe(Math.floor(raw * 0.9));
  });

  it("falls back to raw while cold", () => {
    const mgr = new ContextManager(100000);
    mgr.addMessage({ role: "user", content: "a".repeat(1000) });
    expect(mgr.getContextTokens()).toBe(mgr.getEstimatedTokens());
    expect(mgr.getEstimateDiagnostics().state).toBe("cold");
  });

  it("exposes diagnostics and snapshot fields", () => {
    const mgr = new ContextManager(100000);
    mgr.addMessage({ role: "user", content: "hello" });
    const snap = mgr.getSnapshot();
    expect(snap.estimatedTokensRaw).toBeDefined();
    expect(snap.contextTokens).toBeDefined();
    expect(typeof snap.calibrationRatio).toBe("number");
    expect(["cold", "warming", "trusted", "stale"]).toContain(snap.calibrationState);
  });

  it("invalidates calibration on compact and resize", () => {
    const mgr = new ContextManager(100000);
    for (let i = 0; i < 20; i++) {
      mgr.addMessage({ role: "user", content: `msg ${i}` });
      mgr.addMessage({ role: "assistant", content: `reply ${i}` });
    }
    const raw = mgr.getEstimatedTokens();
    for (let i = 0; i < 3; i++) mgr.calibrate(Math.floor(raw * 0.9), raw, 40);
    expect(mgr.getEstimateDiagnostics().state).toBe("trusted");
    mgr.compact();
    expect(mgr.getEstimateDiagnostics().state).toBe("stale");
  });

  it("safety-clamp refuses an implausible estimate jump", () => {
    const mgr = new ContextManager(34048);
    const msg = { role: "user" as const, content: "x".repeat(2000) };
    mgr.addMessage(msg);
    const first = mgr.checkOverflowAllowed();
    expect(first.allowed).toBe(false); // маленький контекст — не overflow
    // Скачок >3× и >20K токенов без роста числа сообщений.
    msg.content = "y".repeat(400000);
    const second = mgr.checkOverflowAllowed();
    expect(second.implausible).toBe(true);
    expect(second.allowed).toBe(false);
  });
});
