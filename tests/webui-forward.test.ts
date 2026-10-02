import { describe, it, expect, afterEach, vi } from "vitest";
import { createWebUiState, type SseEvent } from "../src/modules/webui/state";
import { makeForwarder } from "../src/modules/webui/session/forward";

describe("webui forwarder", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces text chunks into one event after the flush window", () => {
    vi.useFakeTimers();
    const s = createWebUiState();
    const seen: SseEvent[] = [];
    const fwd = makeForwarder(s, (ev) => seen.push(ev));
    fwd.onText("a");
    fwd.onText("b");
    expect(seen).toHaveLength(0);
    vi.advanceTimersByTime(350);
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe("text");
    expect(seen[0].chunk).toBe("ab");
  });

  it("coalesces meta chunks the same way", () => {
    vi.useFakeTimers();
    const s = createWebUiState();
    const seen: SseEvent[] = [];
    const fwd = makeForwarder(s, (ev) => seen.push(ev));
    fwd.onMeta("m");
    fwd.onMeta("n");
    vi.advanceTimersByTime(350);
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe("meta");
    expect(seen[0].chunk).toBe("mn");
  });

  it("tags tool-body meta with kind so quiet clients can hide it", () => {
    vi.useFakeTimers();
    const s = createWebUiState();
    const seen: SseEvent[] = [];
    const fwd = makeForwarder(s, (ev) => seen.push(ev));
    fwd.onMeta("tool-body", "tool");
    vi.advanceTimersByTime(350);
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe("meta");
    expect(seen[0].chunk).toBe("tool-body");
    expect(seen[0].kind).toBe("tool");
  });

  it("leaves status meta untagged (wire-identical to before)", () => {
    vi.useFakeTimers();
    const s = createWebUiState();
    const seen: SseEvent[] = [];
    const fwd = makeForwarder(s, (ev) => seen.push(ev));
    fwd.onMeta("stats");
    vi.advanceTimersByTime(350);
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe("meta");
    expect(seen[0].chunk).toBe("stats");
    expect("kind" in seen[0]).toBe(false);
  });

  it("splits tool and status meta into separate events on kind change", () => {
    vi.useFakeTimers();
    const s = createWebUiState();
    const seen: SseEvent[] = [];
    const fwd = makeForwarder(s, (ev) => seen.push(ev));
    fwd.onMeta("status-line");
    fwd.onMeta("tool-line", "tool");
    vi.advanceTimersByTime(350);
    expect(seen.map((e) => e.type)).toEqual(["meta", "meta"]);
    expect(seen[0].chunk).toBe("status-line");
    expect("kind" in seen[0]).toBe(false);
    expect(seen[1].chunk).toBe("tool-line");
    expect(seen[1].kind).toBe("tool");
  });
  it("emits a dedicated reasoning event, not meta", () => {
    vi.useFakeTimers();
    const s = createWebUiState();
    const seen: SseEvent[] = [];
    const fwd = makeForwarder(s, (ev) => seen.push(ev));
    fwd.onReasoning("\u001b[2mwhy\u001b[0m");
    fwd.onMeta("stats");
    vi.advanceTimersByTime(350);
    expect(seen.map((e) => e.type)).toEqual(["reasoning", "meta"]);
    expect(seen[0].chunk).toBe("why");
  });

  it("strips ANSI escape codes from streamed meta and text", () => {
    vi.useFakeTimers();
    const s = createWebUiState();
    const seen: SseEvent[] = [];
    const fwd = makeForwarder(s, (ev) => seen.push(ev));
    // The terminal renderer wraps reasoning in `pc.dim` (ESC[2m … ESC[0m) and
    // plugins may colour text; the browser must receive plain text.
    fwd.onMeta("\u001b[2mthinking\u001b[0m");
    fwd.onText("\u001b[31mred\u001b[0m");
    vi.advanceTimersByTime(350);
    expect(seen.map((e) => e.chunk)).toEqual(["red", "thinking"]);
  });

  it("flushes buffered text before a phase and never duplicates it", () => {
    vi.useFakeTimers();
    const s = createWebUiState();
    const seen: SseEvent[] = [];
    const fwd = makeForwarder(s, (ev) => seen.push(ev));
    fwd.onText("x");
    fwd.onPhase("done");
    expect(seen.map((e) => e.type)).toEqual(["text", "phase"]);
    // The phase flush cleared the pending timer: no second `text` fires later.
    vi.advanceTimersByTime(350);
    expect(seen.map((e) => e.type)).toEqual(["text", "phase"]);
  });

  it("onTurnEnd emits turn_end and clears busy", () => {
    vi.useFakeTimers();
    const s = createWebUiState();
    s.busy = true;
    const seen: SseEvent[] = [];
    const fwd = makeForwarder(s, (ev) => seen.push(ev));
    fwd.onTurnEnd({ success: true });
    expect(seen.map((e) => e.type)).toEqual(["turn_end"]);
    expect(s.busy).toBe(false);
  });

  it("flushNow cancels the pending timer so no second text event fires", () => {
    vi.useFakeTimers();
    const s = createWebUiState();
    const seen: SseEvent[] = [];
    const fwd = makeForwarder(s, (ev) => seen.push(ev));
    fwd.onText("z");
    fwd.flushNow();
    vi.advanceTimersByTime(350);
    expect(seen).toHaveLength(1);
    expect(seen[0].chunk).toBe("z");
  });

  it("maps tool start/end to events with their payloads", () => {
    const s = createWebUiState();
    const seen: SseEvent[] = [];
    const fwd = makeForwarder(s, (ev) => seen.push(ev));
    const call = { id: "1", name: "read_file", arguments: { path: "x" } };
    fwd.onToolStart(call);
    fwd.onToolEnd(call, { success: true, output: "ok" }, 12);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ type: "tool_start", toolCallId: "1", name: "read_file" });
    expect(seen[1]).toMatchObject({
      type: "tool_end",
      toolCallId: "1",
      name: "read_file",
      success: true,
      durationMs: 12,
    });
  });

  it("includes clipped tool output with a truncation marker for large results", () => {
    const s = createWebUiState();
    const seen: SseEvent[] = [];
    const fwd = makeForwarder(s, (ev) => seen.push(ev));
    const big = "x".repeat(20_000);
    fwd.onToolEnd({ id: "1", name: "read_file", arguments: {} }, { success: true, output: big }, 5);
    expect(seen).toHaveLength(1);
    const out = String(seen[0].output);
    expect(out).toContain("truncated from");
    expect(out.length).toBeLessThan(big.length);
    expect(out.startsWith("x".repeat(1000))).toBe(true);
  });

  it("scrubs secrets from the broadcast tool output", () => {
    const s = createWebUiState();
    const seen: SseEvent[] = [];
    const fwd = makeForwarder(s, (ev) => seen.push(ev));
    fwd.onToolEnd(
      { id: "1", name: "bash", arguments: {} },
      { success: true, output: "curl -H 'Authorization: Bearer sk-1234567890abcdefghij'\nok" },
      5,
    );
    const out = String(seen[0].output);
    expect(out).not.toContain("sk-1234567890abcdefghij");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts secret-looking tool arguments before broadcasting", () => {
    const s = createWebUiState();
    const seen: SseEvent[] = [];
    const fwd = makeForwarder(s, (ev) => seen.push(ev));
    const call = {
      id: "1",
      name: "bash",
      arguments: {
        command: "curl -H 'Authorization: Bearer sk-1234567890abcdefghij'",
        nested: { token: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" },
        count: 3,
      },
    };
    fwd.onToolStart(call);
    expect(seen).toHaveLength(1);
    const args = seen[0].args as Record<string, unknown>;
    const json = JSON.stringify(args);
    expect(json).not.toContain("sk-1234567890abcdefghij");
    expect(json).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(json).toContain("[REDACTED]");
    expect(args.count).toBe(3);
  });

  it("does not expose a critic SSE surface anymore", () => {
    const fwd = makeForwarder(createWebUiState(), () => {});
    expect((fwd as unknown as Record<string, unknown>).onCritic).toBeUndefined();
  });
});
