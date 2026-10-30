// A13 (P0): отзыв черновика должен быть виден — кто, почему и что это штатная
// перепроверка, а не сбой. Три поверхности: SSE-контракт, лента (плашка) и
// маскот; плюс Trace должен отличать критику от проверки фактов.
import { describe, it, expect, beforeEach } from "vitest";
import { setupHappyDom } from "../helpers/happy-dom";

const win = setupHappyDom(`<div id="msgs" class="msgs"></div>`);

const i18n = await import("../../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = {
  en: {
    "web.feed.retract_head": "draft retracted: {who}",
    "web.feed.retract_no_reason": "re-checking the answer",
    "web.feed.retract_verdict": "verdict: {status}",
    "web.feed.retract_iteration": "iteration {n}",
    "web.action.show": "show",
    "web.action.hide": "hide",
    "web.feed.retract_source_critic": "critic",
    "web.feed.retract_source_hallucination": "fact check",
    "web.feed.retract_source_audit": "plan audit",
    "web.feed.retract_source_check": "verification",
    "web.sidebar.trace_retract": "draft retracted",
    "web.sidebar.trace_retract_src": "draft retracted · {source}",
    "web.sidebar.detail_source": "source",
    "web.sidebar.detail_retract_normal":
      "normal re-check: the gate dropped the draft before the re-answer (not a failure)",
    "web.sidebar.detail_turn": "turn",
    "web.sidebar.detail_time": "time",
    "web.sidebar.detail_iteration": "iteration",
    "web.sidebar.trace_turn": "turn {n}",
  },
};

const store = await import("../../src/modules/webui/assets/js/store.js");
const core = await import("../../src/modules/webui/assets/js/feed/core.js");
const stream = await import("../../src/modules/webui/assets/js/feed/stream.js");
const feedTurn = await import("../../src/modules/webui/assets/js/feed/turn.js");
const loader = await import("../../src/modules/webui/assets/js/loader.js");
const sidebarState = await import("../../src/modules/webui/assets/js/sidebar/state.js");
const trace = await import("../../src/modules/webui/assets/js/sidebar/trace.js");
const { makeForwarder } = await import("../../src/modules/webui/session/forward.js");
const { normalizeHistory } = await import("../../src/modules/webui/session/history-api.js");
const { createWebUiState } = await import("../../src/modules/webui/state.js");

function mountTab(id: string): HTMLElement {
  const feed = win.document.createElement("div");
  feed.className = "feed";
  win.document.body.appendChild(feed);
  store.tabs.tabs = [{ id, feed } as never];
  store.tabs.activeTabId = id;
  store.tabs.liveTabId = id;
  return feed as HTMLElement;
}

beforeEach(() => {
  // Другие тест-файлы в том же процессе перезаписывают глобальный словарь —
  // возвращаем свои строки перед каждым кейсом.
  i18n.I18N.locale = "en";
  i18n.I18N.dicts = {
    en: {
      "web.feed.retract_head": "draft retracted: {who}",
      "web.feed.retract_no_reason": "re-checking the answer",
      "web.feed.retract_verdict": "verdict: {status}",
      "web.feed.retract_iteration": "iteration {n}",
      "web.action.show": "show",
      "web.action.hide": "hide",
      "web.feed.retract_source_critic": "critic",
      "web.feed.retract_source_hallucination": "fact check",
      "web.feed.retract_source_audit": "plan audit",
      "web.feed.retract_source_check": "verification",
      "web.sidebar.trace_retract": "draft retracted",
      "web.sidebar.trace_retract_src": "draft retracted · {source}",
      "web.sidebar.detail_source": "source",
      "web.sidebar.detail_retract_normal":
        "normal re-check: the gate dropped the draft before the re-answer (not a failure)",
      "web.sidebar.detail_turn": "turn",
      "web.sidebar.detail_time": "time",
      "web.sidebar.detail_iteration": "iteration",
      "web.sidebar.trace_turn": "turn {n}",
    },
  };
  store.tabs.tabs = [];
  store.tabs.activeTabId = "";
  store.tabs.liveTabId = "";
});

describe("SSE contract: retract carries who/why/iteration", () => {
  it("passes structured details and keeps the raw label", () => {
    const seen: Array<Record<string, unknown>> = [];
    const fwd = makeForwarder(createWebUiState(), (ev) => seen.push(ev as never));
    fwd.onMeta("↳ draft rejected by verification, refining…", "retract", {
      source: "critic",
      reason: "missing tests",
      iteration: 3,
      verdict: "critical",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe("retract");
    expect(seen[0].source).toBe("critic");
    expect(seen[0].reason).toBe("missing tests");
    expect(seen[0].iteration).toBe(3);
    expect(seen[0].verdict).toBe("critical");
    // Сырой текст метки сохранён для обратной совместимости.
    expect(seen[0].label).toBe("↳ draft rejected by verification, refining…");
  });

  it("degrades to the label when a caller sends no structure", () => {
    const seen: Array<Record<string, unknown>> = [];
    const fwd = makeForwarder(createWebUiState(), (ev) => seen.push(ev as never));
    fwd.onMeta("refining", "retract");
    expect(seen[0].reason).toBe("refining");
    expect(seen[0].label).toBe("refining");
    expect(seen[0].source).toBeUndefined();
  });
});

describe("feed: the retracted draft leaves a collapsed note", () => {
  it("drops the draft, shows only a header and keeps the reason behind the toggle", () => {
    const feed = mountTab("S1");
    stream.onText("half-written answer", "S1");
    stream.onRetract("missing tests", "S1", {
      source: "critic",
      label: "↳ draft rejected by verification, refining…",
      iteration: 3,
      verdict: "critical",
    });
    expect(feed.textContent).not.toContain("half-written answer");
    const block = feed.querySelector<HTMLElement>(".retract-block");
    expect(block).not.toBeNull();
    const head = block!.querySelector<HTMLElement>(".think-h");
    const body = block!.querySelector<HTMLElement>(".think-body");
    // В ленте — только пометка, без прозы критика.
    expect(head?.textContent).toContain("draft retracted: critic");
    expect(head?.textContent).not.toContain("missing tests");
    expect(body?.classList.contains("hidden")).toBe(true);
    expect(body?.textContent).toContain("missing tests");
    expect(body?.textContent).toContain("verdict: critical");
    expect(body?.textContent).toContain("iteration 3");
    // Штатная перепроверка не выглядит ошибкой.
    expect(block?.classList.contains("warn")).toBe(false);
  });

  it("names the hallucination gate differently from the critic", () => {
    const feed = mountTab("S2");
    stream.onText("draft", "S2");
    stream.onRetract("unsupported figure", "S2", { source: "hallucination" });
    const head = feed.querySelector(".retract-block .think-h");
    expect(head?.textContent).toContain("draft retracted: fact check");
    expect(head?.textContent).not.toContain("critic");
    expect(feed.querySelector(".retract-block .think-body")?.textContent).toContain(
      "unsupported figure",
    );
  });

  it("falls back to a neutral source and a human reason when no structure arrives", () => {
    const feed = mountTab("S3");
    stream.onText("draft", "S3");
    stream.onRetract("refining", "S3");
    expect(feed.querySelector(".retract-block .think-h")?.textContent).toContain(
      "draft retracted: verification",
    );
    expect(feed.querySelector(".retract-block .think-body")?.textContent).toContain("refining");
  });

  it("still shows the note when no draft was streamed (the gate is the only signal)", () => {
    const feed = mountTab("S4");
    stream.onRetract("missing tests", "S4", { source: "critic" });
    expect(feed.querySelector(".retract-block .think-h")?.textContent).toContain(
      "draft retracted: critic",
    );
  });

  it("removes a draft that streaming already finalized (live flow: phase done + status)", () => {
    const feed = mountTab("S5");
    stream.onText("finalized draft answer", "S5");
    // Живой порядок: сначала статус гейта закрывает markdown-сегмент, потом
    // приходит retract — черновик к этому моменту уже не `curMd`.
    stream.onMeta("\n↳ checking the result…\n", "S5", "status");
    stream.finishMd(feed);
    stream.onRetract("not delivered", "S5", { source: "critic", iteration: 1 });
    expect(feed.textContent).not.toContain("finalized draft answer");
    expect(feed.querySelector(".retract-block .think-h")?.textContent).toContain(
      "draft retracted: critic",
    );
    // Статус проверки не остаётся висеть после отзыва.
    expect(feed.querySelectorAll(".metaln.status")).toHaveLength(0);
  });
});

describe("history: the rejected draft is dropped and the note survives reload", () => {
  it("drops the assistant draft recorded before the retract event", () => {
    const out = normalizeHistory(
      [
        { ts: "t1", source: "core", type: "user", content: "do it" },
        { ts: "t2", source: "core", type: "assistant", content: "done, file created" },
        {
          ts: "t3",
          source: "core",
          type: "retract",
          content: "file does not exist",
          retractSource: "critic",
          verdict: "critical",
          iteration: 1,
        } as never,
        { ts: "t4", source: "core", type: "assistant", content: "honest answer" },
      ],
      0,
    );
    expect(out.map((e) => e.kind)).toEqual(["user", "retract", "assistant"]);
    expect(out[1]).toMatchObject({
      kind: "retract",
      text: "file does not exist",
      source: "critic",
      verdict: "critical",
      iteration: 1,
    });
    expect(out[2].text).toBe("honest answer");
  });
});

describe("feed: verification status is transient", () => {
  it("keeps only the latest status line and drops it on turn end", () => {
    const feed = mountTab("S6");
    stream.onMeta("\n↳ checking the result…\n", "S6", "status");
    stream.onMeta("\n↳ checking the plan and tests…\n", "S6", "status");
    expect(feed.querySelectorAll(".metaln.status")).toHaveLength(1);
    feedTurn.resetTurnText(feed);
    expect(feed.querySelectorAll(".metaln.status")).toHaveLength(0);
  });
});

describe("mascot: a retracted draft is a re-check, not a failure", () => {
  it("maps retract to its own recheck state", () => {
    expect(loader.loaderStateFor({ type: "retract" })).toBe("recheck");
    expect(loader.loaderStateFor({ type: "retract" })).not.toBe("error");
    // Настоящие сбои по-прежнему красят лицо в error.
    expect(loader.loaderStateFor({ type: "error" })).toBe("error");
    expect(loader.loaderStateFor({ type: "turn_end", success: false })).toBe("error");
  });

  it("styles the recheck state without the error mood", () => {
    const face = loader.createFace("recheck", "sm");
    expect(face.classList.contains("st-recheck")).toBe(true);
    expect(face.classList.contains("st-error")).toBe(false);
    expect(face.classList.contains("sad")).toBe(false);
  });
});

describe("trace: the retract row names the gate and the iteration", () => {
  function mountTrace(): HTMLElement {
    const list = win.document.createElement("div");
    win.document.body.appendChild(list);
    sidebarState.sb.listEl = list as never;
    sidebarState.sb.trace = [];
    sidebarState.sb.turn = 0;
    sidebarState.sb.seq = 0;
    sidebarState.sb.nodeById.clear();
    sidebarState.sb.headerByTurn.clear();
    sidebarState.sb.detailEl = win.document.createElement("div") as never;
    sidebarState.sb.detailGlyph = win.document.createElement("span") as never;
    sidebarState.sb.detailTitle = win.document.createElement("span") as never;
    sidebarState.sb.detailBody = win.document.createElement("div") as never;
    return list as HTMLElement;
  }

  it("labels the row with the source and keeps iteration/verdict in the entry", () => {
    const list = mountTrace();
    trace.sidebarTraceEvent("retract", {
      reason: "missing tests",
      label: "↳ draft rejected by verification, refining…",
      source: "critic",
      iteration: 3,
      verdict: "critical",
    });
    const row = list.querySelector<HTMLElement>(".trc");
    expect(row?.textContent).toContain("draft retracted · critic");
    const entry = sidebarState.sb.trace[0];
    expect(entry.source).toBe("critic");
    expect(entry.reason).toBe("missing tests");
    expect(entry.iteration).toBe(3);
    // Retract — штатное событие: не warning-строка.
    expect(row?.classList.contains("warn")).toBe(false);
  });

  it("explains in detail that this is a normal re-check", () => {
    mountTrace();
    trace.sidebarTraceEvent("retract", {
      reason: "unsupported figure",
      source: "hallucination",
      iteration: 2,
      verdict: "web",
    });
    trace.renderDetail(sidebarState.sb.trace[0]);
    const body = sidebarState.sb.detailBody?.textContent || "";
    expect(body).toContain("normal re-check");
    expect(body).toContain("fact check");
    expect(body).toContain("2");
    expect(body).toContain("web");
  });
});
