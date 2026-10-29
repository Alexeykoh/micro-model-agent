// Guard: смена окна по пробе провайдера — диагностика, а не сообщение в чат.
//
// Живой прогон (ветка fix/stress-register, 2026-10-29): после смены модели в
// ленте обычного режима появлялась строка
// «↳ Context probe: auto-set contextWindow from provider — …».
// Это внутренний счётчик харнесса; в quiet его быть не должно (B-43).
import { describe, it, expect, vi } from "vitest";
import { logContextProbeAutoSet } from "../../src/core/agent/provider-phase";

describe("context probe: только в verbose", () => {
  it("пишет через diagnostic, а не через info", () => {
    const diagnostic = vi.fn();
    const info = vi.fn();

    logContextProbeAutoSet({ diagnostic, info } as never, "m/model", 131072, 65536);

    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(diagnostic.mock.calls[0][0]).toBe("info");
    const text = String(diagnostic.mock.calls[0][1]);
    expect(text).toContain("Context probe");
    expect(text).toContain("m/model");
    expect(text).toContain("131072");
    expect(text).toContain("65536");
    expect(info).not.toHaveBeenCalled();
  });

  it("без логгера не бросает (fail-open)", () => {
    expect(() => logContextProbeAutoSet(undefined, "m", 1, 2)).not.toThrow();
  });
});
