// Guard: пользовательский текст не нормализуется.
//
// Стресс-тест и живая сессия (`ses_mvuy6zpc_otiooomxxrtseqcx`) показали
// многострочный markdown-промпт, схлопнутый в одну строку. Отображение
// пользовательского блока починили отдельно (`tests/webui-user-block-newlines.test.ts`);
// здесь закреплён весь путь: поле ввода → тело POST → очередь/раннер → контекст
// (сборка промпта) и обратно — SSE-чанк ответа → рендер страницы.
//
// Контракт: `\n` не схлопывается в пробел нигде; `\r\n` канонизируется в `\n`;
// отступы и пустые строки сохраняются; единственный `trim()` — проверки
// «пусто?» / «это команда?», в пейлоад он не попадает.
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "../helpers/happy-dom";
import { createWebUiState } from "../../src/modules/webui/state";
import { ContextManager } from "../../src/core/context/manager";
import { withServer, doFetch } from "../helpers/webui-server";

const TEXT = "a\n\n- b\n- c";

// ---------------------------------------------------------------------------
// Часть 1. Поле ввода веба → тело POST.
//
// Контракт живёт в чистом `session/draft.ts` (без DOM): `bun test` кеширует
// модули на процесс, и импорт `composer.ts` из теста зависел бы от того, какой
// DOM-тест выполнился первым. Проверяем чистый шаг + то, что композер берёт
// пейлоад именно из него (без `trim`).
// ---------------------------------------------------------------------------
import { draftForModel } from "../../src/modules/webui/assets/js/session/draft";
import { readFileSync } from "node:fs";

describe("переносы строк: поле ввода веба → POST", () => {
  it("draftForModel не трогает `\\n`, отступы и пустые строки", () => {
    expect(draftForModel(TEXT)).toBe(TEXT);
    expect(draftForModel("  a\n\n- b\n- c\n")).toBe("  a\n\n- b\n- c\n");
    expect(draftForModel("a\n\n\nb")).toBe("a\n\n\nb");
    // Только канон переводов строк: `\r\n` → `\n` (не склейка).
    expect(draftForModel("a\r\nb")).toBe("a\nb");
  });

  it("композер строит пейлоад из draftForModel, без trim", () => {
    const composer = readFileSync("src/modules/webui/assets/js/session/composer.ts", "utf8");
    expect(composer).toContain("draftForModel(inp.value)");
    // Регресс A12: `inp.value.trim()` уходил в тело POST и терял отступ
    // первой строки/хвостовые пустые строки вставленного промпта.
    expect(composer).not.toContain("inp.value.trim()");
  });
});

// ---------------------------------------------------------------------------
// Часть 2. POST → очередь → раннер (без реального LLM).
// ---------------------------------------------------------------------------
function stubRunnerPool() {
  const started: string[] = [];
  const resolvers: Array<(v: unknown) => void> = [];
  const factory = (id: string) =>
    ({
      sessionId: id,
      agent: {
        run: (text: string) => {
          started.push(text);
          return new Promise<unknown>((resolve) => resolvers.push(resolve));
        },
        shutdown: () => {},
      },
      contextManager: { addPendingImage: () => {} },
      execModule: { getActivePlan: () => null },
    }) as never;
  return { started, resolvers, factory };
}

function sessionStub(ids: string[]) {
  return {
    list: () => [],
    get: (id: string) => (ids.includes(id) ? { id } : null) as never,
    getActive: () => ids[0] ?? null,
    setActive: () => {},
    delete: () => {},
  };
}

function fixture() {
  const s = createWebUiState();
  s.minPostIntervalMs = 0;
  s.sessionManager = sessionStub(["A"]) as never;
  const pool = stubRunnerPool();
  s.pool.setFactory(pool.factory);
  return { s, pool };
}

function postMsg(base: string, text: string, sessionId = "A") {
  return doFetch(`${base}/api/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, sessionId }),
  });
}

describe("переносы строк: POST → очередь → раннер", () => {
  it("тело POST доходит до раннера байт-в-байт", async () => {
    const { s, pool } = fixture();
    await withServer(s, async (base) => {
      const r = await postMsg(base, TEXT);
      expect(r.status).toBe(202);
      expect(pool.started).toEqual([TEXT]);
      pool.resolvers.shift()?.({ success: true });
    });
  });

  it("сообщение в очереди сохраняет переносы", async () => {
    const { s, pool } = fixture();
    await withServer(s, async (base) => {
      await postMsg(base, "first");
      const r = await postMsg(base, TEXT);
      expect(r.status).toBe(202);
      expect(s.pool.shift("A")?.text).toBe(TEXT);
      pool.resolvers.shift()?.({ success: true });
    });
  });

  it("сборка промпта (контекст хода) не нормализует текст", () => {
    const cm = new ContextManager(32768);
    cm.addMessage({ role: "user", content: TEXT });
    const history = cm.getActiveHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.content).toBe(TEXT);
    // Провайдеру сообщение уходит через JSON — переносы кодируются, не теряются.
    expect(JSON.stringify(history[0])).toContain("\\n\\n- b\\n- c");
  });
});

// ---------------------------------------------------------------------------
// Часть 3. SSE-чанк ответа → рендер ленты (markdown-режим).
// ---------------------------------------------------------------------------
const win = setupHappyDom(`<div id="msgs" class="msgs"></div>`);
(globalThis as unknown as Record<string, unknown>).DOMParser = (
  win as unknown as Record<string, unknown>
).DOMParser;

const store = await import("../../src/modules/webui/assets/js/store.js");
const stream = await import("../../src/modules/webui/assets/js/feed/stream.js");

function mountTab(id: string): HTMLElement {
  const feed = win.document.createElement("div");
  feed.className = "feed";
  win.document.body.appendChild(feed);
  store.tabs.tabs.push({ id, feed });
  return feed as HTMLElement;
}

describe("переносы строк: SSE-ответ → лента веба", () => {
  it("абзац и список рендерятся разными блоками", () => {
    const feed = mountTab("ML1");
    stream.onText(TEXT, "ML1");
    stream.finishMd(feed);

    expect(feed.querySelectorAll(".md p")).toHaveLength(1);
    expect(feed.querySelector(".md p")?.textContent).toBe("a");
    expect(Array.from(feed.querySelectorAll(".md ul > li")).map((li) => li.textContent)).toEqual([
      "b",
      "c",
    ]);
  });

  it("мягкие переносы остаются переносами, а не одной простынёй", () => {
    const feed = mountTab("ML2");
    stream.onText("line1\nline2\nline3", "ML2");
    stream.finishMd(feed);

    expect(feed.querySelectorAll(".md p")).toHaveLength(1);
    expect(feed.querySelectorAll(".md p br")).toHaveLength(2);
    expect(feed.querySelector(".md p")?.textContent).toBe("line1line2line3");
  });
});
