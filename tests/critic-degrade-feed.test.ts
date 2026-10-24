import { describe, it, expect, vi } from "vitest";
import { CriticGate, type CriticGateDeps } from "../src/core/agent/critic-gate";
import { criticDegradeClass, criticDegradeLine } from "../src/core/agent/critic-degrade-line";
import { createLoopState } from "../src/core/agent/loop-state";
import { createWebUiState, type SseEvent } from "../src/modules/webui/state";
import { makeForwarder } from "../src/modules/webui/session/forward";
import { t } from "../src/i18n/index";

/**
 * Отказ критика обязан быть виден в ленте (долг `critic-degrade-not-in-feed`).
 *
 * Было: `critic_verdict {degraded: true}` + `critic_error` уходили только в
 * `session.jsonl` и app-лог, а ход в `mma web` выглядел завершённым — молчаливый
 * pass неотличим от «проверил и сказал ок». Стало: гейт эмитит одну статус-мету
 * (`↳ проверка не состоялась · <класс>`), которую лента показывает всегда.
 */
describe("critic degrade is visible in the feed", () => {
  function gateDeps(over: Partial<CriticGateDeps> = {}) {
    const state = createLoopState();
    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    const metas: Array<{ text: string; kind?: string }> = [];
    const deps: CriticGateDeps = {
      state,
      iteration: 2,
      logger: { warn: vi.fn(), info: vi.fn(), diagnostic: vi.fn() } as never,
      contextManager: { addMessage: vi.fn() } as never,
      slog: {
        logCritic: (name: string, data: Record<string, unknown> = {}) => events.push({ name, data }),
        logDiagnosticEvent: (name: string, data: Record<string, unknown>) =>
          events.push({ name, data }),
      } as never,
      task: "do it",
      beforeFinish: true,
      toolEvents: [{ tool: "bash", args: { command: "ls" }, ok: true }],
      onMeta: (text, kind) => metas.push({ text, kind }),
      ...over,
    };
    return { deps, events, metas, state };
  }

  const gate = (reason: string | undefined, extra: { enabled?: boolean } = {}) =>
    new CriticGate({
      enabled: extra.enabled ?? true,
      maxCalls: 4,
      maxRepairCycles: 1,
      verify: async () => null,
      buildPack: (x: never) => x,
      degradationReason: () => reason,
    });

  it("emits one status line carrying the cause class", async () => {
    const d = gateDeps();
    await gate("call_timeout (125000ms)").evaluate(d.deps);
    expect(d.metas).toHaveLength(1);
    expect(d.metas[0].kind).toBe("status");
    expect(d.metas[0].text).toContain(t("ui.critic_reason.timeout"));
    expect(d.metas[0].text).not.toContain("125000"); // техническая причина остаётся в логе
  });

  it("keeps the technical cause out of the chat line but in the session log", async () => {
    const d = gateDeps();
    await gate("unparseable_verdict (pass-1): not json").evaluate(d.deps);
    expect(d.metas[0].text).toContain(t("ui.critic_reason.unparseable"));
    const err = d.events.find((e) => e.name === "critic_error");
    expect(err?.data.cause).toBe("unparseable_verdict (pass-1): not json");
  });

  it("stays silent when verification actually happened", async () => {
    const d = gateDeps();
    const okGate = new CriticGate({
      enabled: true,
      maxCalls: 4,
      maxRepairCycles: 1,
      verify: async () => ({ status: "ok", summary: "fine", issues: [] }),
      buildPack: (x: never) => x,
    });
    await okGate.evaluate(d.deps);
    expect(d.metas).toHaveLength(0);
  });

  it("stays silent when the critic is disabled", async () => {
    const d = gateDeps();
    await gate("call_timeout (1000ms)", { enabled: false }).evaluate(d.deps);
    expect(d.metas).toHaveLength(0);
  });

  it("classifies every reason the client can report, and falls back honestly", () => {
    expect(criticDegradeClass("call_timeout (1000ms)")).toBe("timeout");
    expect(criticDegradeClass("unparseable_verdict (pass-2): x")).toBe("unparseable");
    expect(criticDegradeClass("checks_loop_failed: boom")).toBe("checks");
    expect(criticDegradeClass("llm_error: provider down")).toBe("llm");
    expect(criticDegradeClass("no verdict returned")).toBe("none");
    expect(criticDegradeClass(undefined)).toBe("none");
    expect(criticDegradeLine("checks_loop_failed: boom")).toContain(
      t("ui.critic_reason.checks"),
    );
  });

  it("reaches the browser as a status meta event (not quiet-gated as a tool body)", () => {
    const seen: SseEvent[] = [];
    const fwd = makeForwarder(createWebUiState(), (ev) => seen.push(ev));
    fwd.onMeta(`\n${criticDegradeLine("llm_error: down")}\n`, "status");
    fwd.flushNow();
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe("meta");
    // `kind: "tool"` клиент скрывает в quiet-режиме; статус показывается всегда.
    expect((seen[0] as { kind?: string }).kind).not.toBe("tool");
    expect(String(seen[0].chunk)).toContain(t("ui.critic_reason.llm"));
  });
});
