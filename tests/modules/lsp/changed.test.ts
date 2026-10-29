// Guard: список изменённых файлов для панели LSP — git status, без обхода
// проекта; удалённые и .mma/ отбрасываются, лимит соблюдается.
import { describe, it, expect } from "vitest";
import { parsePorcelain } from "../../../src/modules/lsp/changed";

describe("parsePorcelain", () => {
  it("берёт modified и untracked, отбрасывает deleted и .mma", () => {
    const out = " M a.ts\u0000 D b.ts\u0000?? c.ts\u0000?? .mma/NOTES.md\u0000";
    expect(parsePorcelain(out)).toEqual(["a.ts", "c.ts"]);
  });

  it("соблюдает лимит", () => {
    const out = Array.from({ length: 5 }, (_, i) => `?? f${i}.ts`).join("\u0000");
    expect(parsePorcelain(out, 2)).toEqual(["f0.ts", "f1.ts"]);
  });
});
