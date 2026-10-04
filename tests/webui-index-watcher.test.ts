import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  attachIndexWatcher,
  type WatchableIndexer,
} from "../src/modules/webui/index-watcher";

describe("attachIndexWatcher", () => {
  it("arms the watcher on attach and disarms it on detach", () => {
    let on = 0;
    let off = 0;
    const indexer: WatchableIndexer = {
      watch: () => {
        on += 1;
      },
      unwatch: () => {
        off += 1;
      },
    };

    const detach = attachIndexWatcher(indexer);
    expect(on).toBe(1);
    expect(off).toBe(0);

    detach();
    expect(off).toBe(1);
  });

  it("is a no-op for a stub without watch/unwatch", () => {
    const detach = attachIndexWatcher(undefined);
    expect(() => detach()).not.toThrow();

    const bare: WatchableIndexer = {};
    expect(() => attachIndexWatcher(bare)()).not.toThrow();
  });

  it("is wired into startWebUi/stop", () => {
    const src = readFileSync(
      join(import.meta.dirname, "..", "src", "modules", "webui", "module.ts"),
      "utf-8",
    );
    expect(src).toContain("attachIndexWatcher(deps.indexer)");
    expect(src).toContain("detachIndexWatcher()");
  });
});
