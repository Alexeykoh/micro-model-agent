// A14 (P1): Trace-лента перевёрнута — свежие строки сверху, автоскролл не
// дёргает читателя истории, кнопка «↑ свежее» возвращает к верхней (свежей)
// кромке. Плюс `gate_timing` (A15): строка простоя хода в гейтах только выше
// порога, чтобы событие из лога было видно, но не шумело.
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "../helpers/happy-dom";
import type { SessionLogEntry } from "../../src/modules/session/store";

const win = setupHappyDom(`
  <div class="sb" data-sid="S1">
    <div class="sb-pane" id="pane-trace">
      <div class="trace-main">
        <div class="trace-head">
          <button class="linkbtn trace-top" type="button" id="traceTopBtn" hidden></button>
          <button class="linkbtn" type="button" id="tracePromptBtn"></button>
        </div>
        <div class="trace-list" id="traceList"></div>
      </div>
    </div>
  </div>`);

const DICT = {
  "web.sidebar.trace_empty": "no events yet",
  "web.sidebar.trace_turn": "turn {n}",
  "web.sidebar.trace_log": "log · {level}",
  "web.sidebar.trace_text": "composing… {count} chars",
  "web.sidebar.trace_status": "status",
  "web.sidebar.trace_latest": "↑ latest",
  "web.sidebar.trace_gate_timing":
    "turn waited in gates: {ms} ms · critic {critic} · audit {audit}",
  "web.sidebar.trace_gate_total": "gates {ms} ms",
  "web.sidebar.trace_gate_hallucination": "fact check",
  "web.sidebar.trace_gate_critic": "critic",
  "web.sidebar.trace_gate_audit": "audit",
};

const g = globalThis as unknown as Record<string, unknown>;
const i18n = await import("../../src/modules/webui/assets/js/i18n.js");
i18n.I18N.locale = "en";
i18n.I18N.dicts = { en: DICT };

const { sb } = await import("../../src/modules/webui/assets/js/sidebar/state.js");
const trace = await import("../../src/modules/webui/assets/js/sidebar/trace.js");
const scroll = await import("../../src/modules/webui/assets/js/sidebar/trace-scroll.js");
const { tailSessionLog } = await import("../../src/modules/webui/session/log-api.js");

// `scrollHeight` в happy-dom всегда 0 (нет layout). Прежняя реализация читала
// его на каждую строку; тест эмулирует длинную ленту, чтобы «приклеивание к
// низу» было видно.
const LIST_HEIGHT = 1000;

function mount(turn = 1): HTMLElement {
  // Соседние DOM-файлы делят процесс и подменяют глобалы — возвращаем свои.
  g.window = win;
  g.document = win.document;
  g.localStorage = win.localStorage;
  i18n.I18N.locale = "en";
  i18n.I18N.dicts = { en: DICT };

  const list = win.document.getElementById("traceList") as HTMLElement;
  list.innerHTML = "";
  list.scrollTop = 0;
  Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => LIST_HEIGHT });

  sb.el = win.document.querySelector(".sb") as HTMLElement;
  sb.listEl = list;
  sb.trace = [];
  sb.turn = turn;
  sb.seq = 0;
  sb.nodeById.clear();
  sb.headerByTurn.clear();
  sb.callIndex.clear();
  sb.textEntry = null;
  sb.reasonEntry = null;
  trace.renderList();
  scroll.initTraceScroll();
  return list;
}

const rowTexts = (list: HTMLElement): string[] =>
  [...list.querySelectorAll<HTMLElement>(".trc")].map((n) => n.textContent || "");
const heads = (list: HTMLElement): string[] =>
  [...list.querySelectorAll<HTMLElement>(".trace-turn")].map((n) => n.textContent || "");

describe("trace: свежие строки сверху", () => {
  it("keeps the newest turn and its newest event on top", () => {
    const list = mount(1);
    trace.sidebarTraceEvent("log", { text: "first", level: "info" });
    trace.sidebarTurnEnd(2);
    trace.sidebarTraceEvent("log", { text: "second", level: "info" });
    trace.sidebarTraceEvent("log", { text: "third", level: "info" });

    // Ход не разрезан: заголовок всегда первый узел своего блока.
    expect((list.firstElementChild as HTMLElement).classList.contains("trace-turn")).toBe(true);
    expect(heads(list)).toEqual(["turn 2", "turn 1"]);
    // Внутри хода свежие события выше старых.
    expect(rowTexts(list)[0]).toContain("third");
    expect(rowTexts(list)[1]).toContain("second");
    expect(rowTexts(list)[2]).toContain("first");
    // Заголовок свежего хода стоит выше всех своих строк.
    const nodes = [...list.children] as HTMLElement[];
    expect(nodes[0].textContent).toBe("turn 2");
    expect(nodes[1].textContent).toContain("third");
    expect(nodes[nodes.length - 1].textContent).toContain("first");
  });

  it("rebuilds the list newest-first (session switch / i18n re-render)", () => {
    const list = mount(1);
    trace.sidebarTraceEvent("log", { text: "one", level: "info" });
    trace.sidebarTurnEnd(2);
    trace.sidebarTraceEvent("log", { text: "two", level: "info" });
    trace.renderList();

    expect(heads(list)).toEqual(["turn 2", "turn 1"]);
    expect(list.scrollTop).toBe(0);
  });

  it("batches streamed row updates into one frame", () => {
    const list = mount(1);
    const frames: Array<() => void> = [];
    const prevRaf = g.requestAnimationFrame;
    const prevCaf = g.cancelAnimationFrame;
    g.requestAnimationFrame = (cb: () => void) => {
      frames.push(cb);
      return frames.length;
    };
    g.cancelAnimationFrame = () => {};
    try {
      trace.sidebarTraceEvent("text", { chunk: "he" });
      trace.sidebarTraceEvent("text", { chunk: "llo" });
      // Один кадр на пачку чанков, строка ещё не перерисована.
      expect(frames).toHaveLength(1);
      expect(rowTexts(list)[0]).not.toContain("5");
      frames[0]();
      expect(rowTexts(list)[0]).toContain("5");
    } finally {
      g.requestAnimationFrame = prevRaf;
      g.cancelAnimationFrame = prevCaf;
      scroll.flushTraceFrame();
    }
  });
});

describe("trace: скролл не дёргает читателя истории", () => {
  it("does not jump to the bottom edge on every insert", () => {
    const list = mount(1);
    trace.sidebarTraceEvent("log", { text: "a", level: "info" });
    scroll.flushTraceFrame();
    // Свежая кромка — верх: ни `scrollHeight`, ни «приклеивания к низу».
    expect(list.scrollTop).toBe(0);
  });

  it("keeps the reading position while history is being read", () => {
    const list = mount(1);
    list.scrollTop = 300;
    list.dispatchEvent(new win.Event("scroll"));

    trace.sidebarTraceEvent("log", { text: "b", level: "info" });
    trace.sidebarTraceEvent("text", { chunk: "token" });
    scroll.flushTraceFrame();

    expect(list.scrollTop).toBe(300);
  });

  it("follows the fresh edge again after returning to top", () => {
    const list = mount(1);
    list.scrollTop = 240;
    list.dispatchEvent(new win.Event("scroll"));
    trace.sidebarTraceEvent("log", { text: "c", level: "info" });
    scroll.flushTraceFrame();
    expect(list.scrollTop).toBe(240);

    list.scrollTop = 0;
    list.dispatchEvent(new win.Event("scroll"));
    trace.sidebarTraceEvent("log", { text: "d", level: "info" });
    scroll.flushTraceFrame();
    expect(list.scrollTop).toBe(0);
  });
});

describe("trace: кнопка «к свежим»", () => {
  it("appears when the reader dives into history and returns to fresh rows", () => {
    const list = mount(1);
    const btn = win.document.getElementById("traceTopBtn") as HTMLButtonElement;
    trace.sidebarTraceEvent("log", { text: "x", level: "info" });
    expect(btn.hidden).toBe(true);
    expect(btn.textContent).toBe("↑ latest");

    list.scrollTop = 480;
    list.dispatchEvent(new win.Event("scroll"));
    expect(btn.hidden).toBe(false);

    btn.click();
    expect(list.scrollTop).toBe(0);
    expect(btn.hidden).toBe(true);
  });
});

describe("trace: gate_timing (A15) виден только при заметном простое", () => {
  it("skips short gate stalls and renders a long one with the breakdown", () => {
    const list = mount(1);
    trace.appendLogEntry({
      type: "gate_timing",
      duration: 1200,
      gates: { hallucination: 100, critic: 900, audit: 200 },
      iteration: 1,
    });
    expect(rowTexts(list)).toHaveLength(0);

    trace.appendLogEntry({
      type: "gate_timing",
      duration: 4200,
      gates: { hallucination: 100, critic: 3400, audit: 700 },
      iteration: 2,
    });
    const rows = rowTexts(list);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("4200");
    expect(rows[0]).toContain("critic 3400");
    expect(rows[0]).toContain("audit 700");
    expect(sb.trace[0].kind).toBe("gate");
    // Разбивка в детали: нули опускаются, простой по гейтам читается.
    expect(sb.trace[0].text).toBe(
      "gates 4200 ms · fact check 100 ms · critic 3400 ms · audit 700 ms",
    );
  });

  it("tailSessionLog carries gate_timing and the gate breakdown", () => {
    const entries: SessionLogEntry[] = [
      {
        ts: "2026-10-30T00:00:00.000Z",
        type: "gate_timing",
        source: "core",
        duration: 4200,
        gates: { hallucination: 100, critic: 3400, audit: 700 },
      },
    ];
    const out = tailSessionLog(entries, { types: ["gate_timing"] });
    expect(out.map((e) => e.type)).toEqual(["gate_timing"]);
    expect(out[0].duration).toBe(4200);
    expect(out[0].gates).toEqual({ hallucination: 100, critic: 3400, audit: 700 });
  });
});
