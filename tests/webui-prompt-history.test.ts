// Чистые функции истории промптов (стрелки ▲/▼ в композере) — без DOM.
import { describe, it, expect } from "vitest";
import {
  HISTORY_CAP,
  browseDown,
  browseUp,
  createEntry,
  downFor,
  record,
  recordFor,
  upFor,
} from "../src/modules/webui/assets/js/session/prompt-history";

describe("prompt history: record", () => {
  it("trims and skips empty entries", () => {
    const e = createEntry();
    record(e, "  hello  ");
    record(e, "   ");
    expect(e.items).toEqual(["hello"]);
  });

  it("dedupes a repeat of the last message", () => {
    const e = createEntry();
    record(e, "a");
    record(e, "a");
    record(e, "b");
    expect(e.items).toEqual(["a", "b"]);
  });

  it("caps length, evicting the oldest", () => {
    const e = createEntry();
    for (let i = 0; i < HISTORY_CAP + 5; i++) record(e, `m${i}`);
    expect(e.items).toHaveLength(HISTORY_CAP);
    expect(e.items[0]).toBe("m5");
    expect(e.items[HISTORY_CAP - 1]).toBe(`m${HISTORY_CAP + 4}`);
  });

  it("a new record resets browsing", () => {
    const e = createEntry();
    record(e, "a");
    browseUp(e, "");
    expect(e.cursor).toBe(0);
    record(e, "b");
    expect(e.cursor).toBe(-1);
  });
});

describe("prompt history: browse (shell semantics)", () => {
  it("up walks newest→oldest, down returns to the draft", () => {
    const e = createEntry();
    record(e, "first");
    record(e, "second");
    record(e, "third");

    expect(browseUp(e, "draft")).toBe("third"); // первый подъём: запоминаем черновик
    expect(browseUp(e, "third")).toBe("second");
    expect(browseUp(e, "second")).toBe("first");
    expect(browseUp(e, "first")).toBeNull(); // старше нечего: курсор стоит на `first`
    // ▼ с заблокированной позиции даёт СЛЕДУЮЩЕЕ после показанного (bash-семантика).
    expect(browseDown(e)).toBe("second");
    expect(browseDown(e)).toBe("third");
    expect(browseDown(e)).toBe("draft"); // «дно» — возвращён сохранённый черновик
    expect(browseDown(e)).toBeNull(); // не листаем — ▼ ничего не делает
  });

  it("empty history: up is a no-op", () => {
    const e = createEntry();
    expect(browseUp(e, "draft")).toBeNull();
    expect(e.cursor).toBe(-1);
  });

  it("editing the draft then browsing up re-captures the new draft", () => {
    const e = createEntry();
    record(e, "a");
    browseUp(e, "old draft");
    browseDown(e); // обратно к черновику
    expect(browseUp(e, "typed something")).toBe("a");
    expect(browseDown(e)).toBe("typed something");
  });
});

describe("prompt history: per-key store", () => {
  it("keys isolate sessions; record/up/down go through the same entry", () => {
    recordFor("S1", "one");
    recordFor("S2", "two");
    expect(upFor("S1", "")).toBe("one");
    expect(upFor("S2", "")).toBe("two");
    expect(downFor("S1")).toBe(""); // сохранённый пустой черновик
  });
});
