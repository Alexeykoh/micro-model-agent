import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_EVENTS } from "../../src/output/types";
import { ALLOWED_TYPES, TRACE_LOG_TYPES } from "../../src/modules/webui/session/log-api";

/**
 * Gate W0 (INV-15): сигнал, записанный в `session.jsonl`, должен быть доступен
 * поверхности разбора. Закрытый whitelist Trace не имеет права отставать от
 * `DiagnosticEvent` — иначе деградация есть в журнале, но в UI её нет.
 */
describe("web Trace: диагностические типы не фильтруются", () => {
  it("каждый DiagnosticEvent разрешён роутом лога", () => {
    const missing = DIAGNOSTIC_EVENTS.filter((type) => !ALLOWED_TYPES.has(type));
    expect(missing, `Trace не отдаёт сигналы: ${missing.join(", ")}`).toEqual([]);
  });

  it("каждый DiagnosticEvent докачивается живым Trace", () => {
    const trace = new Set<string>(TRACE_LOG_TYPES);
    const missing = DIAGNOSTIC_EVENTS.filter((type) => !trace.has(type));
    expect(missing, `Trace не показывает сигналы: ${missing.join(",")}`).toEqual([]);
  });
});
