/**
 * W9: мета-канал (`onMeta`) больше не теряется на сервисе.
 *
 * Локальный REPL печатает статусы, тела тулов, отзыв черновика и итог
 * критика; thin-клиент получал только текст. Мост обязан сохранять вид
 * (`kind`) и структуру (`retract`/`critic`), иначе паритет рендера недостижим.
 */
import { describe, expect, it } from "vitest";
import { makeServiceForwarder } from "../../src/modules/service/runtime/event-bridge";

interface Emitted {
  type: string;
  data: Record<string, unknown>;
  attempt: number;
}

function bridge() {
  const events: Emitted[] = [];
  const fwd = makeServiceForwarder({
    emit: (type, data, attempt) => events.push({ type, data: data as Record<string, unknown>, attempt }),
    flushMs: 1,
  });
  return { events, fwd };
}

describe("service forwarder meta channel (W9)", () => {
  it("buffers meta chunks and flushes them with their kind", () => {
    const { events, fwd } = bridge();
    fwd.onMeta("ctx 1k", "status");
    fwd.onMeta(" / 32k", "status");
    fwd.flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "meta", data: { chunk: "ctx 1k / 32k", kind: "status" } });
  });

  it("starts a new meta event when the kind changes", () => {
    const { events, fwd } = bridge();
    fwd.onMeta("body", "tool");
    fwd.onMeta("status", "status");
    fwd.flush();

    expect(events.map((e) => [e.type, e.data.kind])).toEqual([
      ["meta", "tool"],
      ["meta", "status"],
    ]);
  });

  it("emits retract as a structured event with label and reason", () => {
    const { events, fwd } = bridge();
    fwd.onMeta("draft pulled", "retract", {
      source: "critic",
      reason: "claim not supported",
      iteration: 2,
      verdict: "concern",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "retract",
      data: {
        label: "draft pulled",
        reason: "claim not supported",
        source: "critic",
        iteration: 2,
        verdict: "concern",
      },
    });
  });

  it("emits critic with the report structure and the terminal label", () => {
    const { events, fwd } = bridge();
    const report = {
      status: "success",
      durationMs: 12,
      passes: 1,
      issues: [],
      checks: [{ tool: "read_file", ok: true }],
      summary: "looks fine",
    };
    fwd.onMeta("critic: success", "critic", { source: "critic", critic: report, verdict: "success" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "critic",
      data: {
        label: "critic: success",
        status: "success",
        durationMs: 12,
        passes: 1,
        issues: [],
        summary: "looks fine",
        verdict: "success",
      },
    });
    expect((events[0].data.checks as unknown[]).length).toBe(1);
  });

  it("discard drops buffered meta instead of leaking a rejected draft", () => {
    const { events, fwd } = bridge();
    fwd.onMeta("hidden", "tool");
    fwd.discard();
    fwd.flush();

    expect(events).toEqual([]);
  });

  it("strips ANSI from meta so non-terminal clients get plain text", () => {
    const { events, fwd } = bridge();
    fwd.onMeta("\u001b[2mdim\u001b[0m", "status");
    fwd.flush();

    expect(events[0]?.data.chunk).toBe("dim");
  });
});
