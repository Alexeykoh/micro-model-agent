import { describe, expect, it } from "vitest";
import { signalForOperation } from "../../src/core/bootstrap/tool-context";
import { DIAGNOSTIC_EVENTS } from "../../src/output/types";

/**
 * Gate W0: сигнатура диагностики выводится из операции, а не сваливается в
 * `admission_degraded`. Иначе деградация провайдера/модуля/плагина попадает в
 * журнал под чужим именем и в разборе неотличима от admission.
 */
describe("signalForOperation: домен отказа", () => {
  it("оставляет специальные операции под их сигналом", () => {
    expect(signalForOperation("admit")).toBe("admission_degraded");
    expect(signalForOperation("hallucination.judge")).toBe("hallucination_judge_degraded");
    expect(signalForOperation("taint.rehydrate")).toBe("taint_degraded");
    expect(signalForOperation("tool.execute")).toBe("tool_attempt");
    expect(signalForOperation("tool.syntax_precheck")).toBe("verify_error");
    expect(signalForOperation("context.compaction")).toBe("context_degraded");
    expect(signalForOperation("ssrf.dns")).toBe("ssrf_degraded");
  });

  it("выводит домен по префиксу операции", () => {
    expect(signalForOperation("provider.context_probe")).toBe("provider_degraded");
    expect(signalForOperation("llm.http_retry")).toBe("provider_degraded");
    expect(signalForOperation("mcp.connect")).toBe("module_degraded");
    expect(signalForOperation("lsp.server_exit")).toBe("module_degraded");
    expect(signalForOperation("index.build")).toBe("module_degraded");
    expect(signalForOperation("memory.prefs_read")).toBe("module_degraded");
    expect(signalForOperation("browser.launch")).toBe("module_degraded");
    expect(signalForOperation("session.log.read")).toBe("session_degraded");
    expect(signalForOperation("plugin.hook")).toBe("hook_degraded");
    expect(signalForOperation("config.manifest_probe")).toBe("config_degraded");
    expect(signalForOperation("service.webhook.deliver")).toBe("delivery_degraded");
    expect(signalForOperation("tool.grep")).toBe("tool_degraded");
  });

  it("неизвестная операция не маскируется под admission", () => {
    expect(signalForOperation("future.operation")).toBe("tool_degraded");
  });

  it("объявляет отдельный сигнал успешного failover", () => {
    expect(DIAGNOSTIC_EVENTS).toContain("provider_failover");
  });
});
