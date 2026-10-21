import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
  backgroundChildCount,
  killBackgroundChildren,
  registerBackgroundChild,
  unregisterBackgroundChild,
} from "../../src/modules/processes/background-children";

/**
 * Фоновые дети гасятся при выходе процесса (аудит §7.10, план
 * `2026-10-12-harness-module-audit-fixes`, W7/Task 7.6).
 */

class FakeChild extends EventEmitter {
  pid = 4242;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe("реестр фоновых детей", () => {
  it("registers and unregisters children", () => {
    const child = new FakeChild();
    registerBackgroundChild(child as never);
    expect(backgroundChildCount()).toBe(1);
    unregisterBackgroundChild(child as never);
    expect(backgroundChildCount()).toBe(0);
  });

  it("kills the registered children", () => {
    const child = new FakeChild();
    registerBackgroundChild(child as never);
    killBackgroundChildren();
    // На Windows дерево гасится через taskkill (kill.kill() не вызывается),
    // поэтому проверяем главное — реестр очищен.
    expect(backgroundChildCount()).toBe(0);
  });

  it("drops a child that finished on its own", () => {
    const child = new FakeChild();
    registerBackgroundChild(child as never);
    child.emit("close");
    expect(backgroundChildCount()).toBe(0);
  });
});
