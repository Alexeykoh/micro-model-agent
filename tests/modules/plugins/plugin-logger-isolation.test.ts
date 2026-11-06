// Логгер плагинов принадлежит конкретному менеджеру (INV-15).
//
// Раньше логгер был глобальным «текущим»: любой `new PluginManager()` — в том
// числе лёгкий менеджер субагента или pipeline — перетирал его. Предупреждение
// одного менеджера уезжало в каталог чужой сессии (или терялось совсем).
import { describe, expect, it } from "vitest";
import { PluginManager } from "../../../src/modules/plugins/manager";
import type { AgentPlugin } from "../../../src/modules/types";
import type { ToolCall } from "../../../src/tools/types";

/** Логгер-сборщик: видим, куда ушло предупреждение. */
function collector(): {
  log: { warn: (m: string) => void; diagnostic: (l: string, m: string) => void };
  lines: string[];
} {
  const lines: string[] = [];
  return {
    lines,
    log: {
      warn: (m: string) => lines.push(m),
      diagnostic: (_level: string, m: string) => lines.push(m),
    },
  };
}

function brokenPlugin(): AgentPlugin {
  return {
    name: "broken",
    version: "1.0.0",
    onBeforeTool() {
      throw new Error("hook boom");
    },
  };
}

const CALL: ToolCall = { id: "c1", name: "read_file", arguments: {} };

describe("плагины: логгер принадлежит менеджеру", () => {
  it("предупреждение уходит в логгер своего менеджера", async () => {
    const a = collector();
    const b = collector();
    const mgrA = new PluginManager(a.log);
    // Второй менеджер (например, раннер сессии) не должен перехватывать логгер.
    const mgrB = new PluginManager(b.log);
    expect(mgrB).toBeTruthy();

    mgrA.register(brokenPlugin(), "builtin");
    await mgrA.runOnBeforeTool({}, CALL);

    expect(a.lines.some((l) => l.includes("onBeforeTool failed"))).toBe(true);
    expect(b.lines).toHaveLength(0);
  });

  it("менеджер без логгера не отнимает логгер у другого", async () => {
    const a = collector();
    const mgrA = new PluginManager(a.log);
    // Лёгкий менеджер субагента — без проводки (см. `subagent-run.ts`).
    const light = new PluginManager();
    expect(light).toBeTruthy();

    mgrA.register(brokenPlugin(), "builtin");
    await mgrA.runOnBeforeTool({}, CALL);

    expect(a.lines.some((l) => l.includes("onBeforeTool failed"))).toBe(true);
  });
});
