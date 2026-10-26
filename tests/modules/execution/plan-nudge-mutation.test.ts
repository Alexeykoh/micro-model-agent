/**
 * Нудж «создай план» — по факту мутации, а не по имени тула.
 *
 * в `ses_mvphq4s8` агент получил
 * «Ты сделал(а) 2 вызова, изменяющих файлы, без плана» после `docker ps` и
 * `ls`, создал ненужный план и потратил полхода на его бухгалтерию.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { ExecutionModule } from "../../../src/modules/execution/module";
import { createTestModule } from "../../plan-test-utils";

describe("нудж плана: read-only bash не мутация", () => {
  let tmpDir: string;
  let mod: ExecutionModule;
  const plugin = () => (mod as unknown as { getPlugin(): any }).getPlugin();

  beforeEach(() => {
    tmpDir = createTestModule("mma-plan-nudge-").tmpDir;
    mod = new ExecutionModule(tmpDir, 8);
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  function makeCtx() {
    return {
      contextManager: { addMessage: vi.fn() },
      sessionLog: { plan: vi.fn(), directive: vi.fn() },
      logger: { warn: vi.fn(), debug: vi.fn() },
      iteration: 0,
    } as any;
  }

  /** Прогоняет N read-only bash-вызовов и возвращает текст нуджа плана. */
  function runReadOnly(calls: string[]): string[] {
    const ctx = makeCtx();
    const p = plugin();
    for (const command of calls) {
      p.onToolCall({ ...ctx, toolName: "bash", args: { command } });
      p.onBeforeThink(ctx);
    }
    return (ctx.contextManager.addMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String((c[0] as { content?: string })?.content ?? ""))
      .filter((text: string) => /plan|план/i.test(text) && /call|вызов/i.test(text));
  }

  it("не требует план после read-only диагностики", () => {
    const nudge = runReadOnly([
      "docker ps -a --format \"{{.Names}} | {{.Status}}\"",
      "docker logs lampac --tail 60",
      "ls -la /tmp",
      "cat config/init.conf",
    ]);
    expect(nudge).toEqual([]);
  });

  it("требует план после записи в файл через bash", () => {
    const nudge = runReadOnly([
      "git commit -m \"fix\"",
      "echo hi > out.txt",
      "docker cp lampac:/lampac/current.conf ./current.conf",
    ]);
    expect(nudge.length).toBe(1);
  });
});
