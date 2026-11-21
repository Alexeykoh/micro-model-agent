// Регресс («обычный» режим веб-ленты): тело тула рисовалось ДВАЖДЫ —
// dim-строкой из `meta(kind:"tool")` и вторым экземпляром в `.toolout` боксе
// из `tool_end`. Владелец тела — `meta` (паритет с терминальным BodyStream),
// `tool_end` только ставит статус на строку действия.
import { describe, it, expect, beforeEach } from "vitest";
import { setupHappyDom } from "../helpers/happy-dom";

const win = setupHappyDom(`<div id="msgs" class="msgs"></div>`);

const i18n = await import("../../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = { en: {} };

const store = await import("../../src/modules/webui/assets/js/store.js");
const stream = await import("../../src/modules/webui/assets/js/feed/stream.js");
const turn = await import("../../src/modules/webui/assets/js/feed/turn.js");

const BODY = ".gitignore\n1c-skills\nmath.js\nmath.test.js";

function mountTab(id: string): HTMLElement {
  const feed = win.document.createElement("div");
  feed.className = "feed";
  win.document.body.appendChild(feed);
  store.tabs.tabs = [{ id, feed } as never];
  store.tabs.activeTabId = id;
  store.tabs.liveTabId = id;
  return feed as HTMLElement;
}

// Реальный порядок SSE: tool_start → meta(kind:"tool") → tool_end с тем же
// выводом (оба канала несут `data.output` результата).
function runBash(id: string, body: string): void {
  turn.onToolStart({
    sessionId: id,
    toolCallId: "call-1",
    name: "bash",
    args: { command: "dir /b project3" },
  });
  stream.onMeta(`\n${body}\n`, id, "tool");
  turn.onToolEnd({
    sessionId: id,
    toolCallId: "call-1",
    name: "bash",
    success: true,
    durationMs: 56,
    output: body,
  });
}

beforeEach(() => {
  store.tabs.tabs = [];
  store.tabs.activeTabId = "";
  store.tabs.liveTabId = "";
});

describe.each(["normal", "verbose"] as const)("web feed: режим %s", (mode) => {
  it("рисует тело тула один раз — без второго .toolout", () => {
    store.settings.config = { ui: { verbosity: mode } };
    const id = `${mode}-dup`;
    const feed = mountTab(id);
    runBash(id, BODY);

    expect(feed.querySelectorAll(".toolout")).toHaveLength(0);
    expect(feed.querySelectorAll(".metaln")).toHaveLength(1);
    expect((feed.textContent || "").match(/math\.test\.js/g)).toHaveLength(1);
    // Строка действия со статусом остаётся — терять её нельзя.
    expect(feed.querySelector(".act .ok")?.textContent).toContain("✓ 56ms");
  });
});

describe("web feed: quiet", () => {
  it("не показывает тело совсем (ни meta, ни box)", () => {
    store.settings.config = { ui: { verbosity: "quiet" } };
    const feed = mountTab("quiet-dup");
    runBash("quiet-dup", BODY);

    expect(feed.querySelectorAll(".toolout")).toHaveLength(0);
    expect(feed.querySelectorAll(".metaln")).toHaveLength(0);
    expect(feed.textContent || "").not.toContain("math.test.js");
  });
});
