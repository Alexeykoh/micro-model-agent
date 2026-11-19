import { describe, it, expect } from "vitest";
import { OutputBus } from "../../src/output/bus";
import { OutputChannel } from "../../src/output/channel";
import { createPromptIO } from "../../src/tools/prompt-io";

/**
 * Меню интерактивного вопроса видно СРАЗУ: в модалке события копятся в очереди
 * и печатаются лишь после ответа — значит, меню должно идти мимо очереди
 * (аудит §8.10, план `2026-10-12-harness-module-audit-fixes`, W9/Task 9.1).
 */

class S {
  data = "";
  write(s: string): boolean {
    this.data += s;
    return true;
  }
}

function channel() {
  const bus = new OutputBus();
  const out = new S();
  const c = new OutputChannel(bus, { out: out as never, err: out as never, color: false });
  return { bus, out, c };
}

describe("меню вопроса", () => {
  it("is printed immediately, bypassing the modal queue", async () => {
    const { out, c } = channel();
    c.beginModal();

    // Обычная блочная запись в модалке ЖДЁТ (копится в очереди)…
    c.writeLine("queued line");
    expect(out.data).toBe("");

    // …а модальная — печатается сразу.
    c.writeModal("menu line");
    expect(out.data).toContain("menu line");

    c.endModal();
    expect(out.data).toContain("queued line");
  });

  it("prints the choice menu before waiting for input", async () => {
    const { out, c } = channel();
    c.beginModal();
    const order: string[] = [];
    const io = createPromptIO({
      ask: async () => {
        order.push("ask");
        return "1";
      },
      print: (line) => {
        order.push("print");
        c.writeModal(line);
      },
    });

    const pending = io.askChoice("Выберите", [
      { label: "первый вариант", description: "первое" },
      { label: "второй вариант", description: "второе" },
    ]);
    // Меню напечатано ДО того, как вопрос задан.
    expect(order[0]).toBe("print");
    expect(out.data).toContain("первый вариант");

    await pending;
    c.endModal();
  });
});
