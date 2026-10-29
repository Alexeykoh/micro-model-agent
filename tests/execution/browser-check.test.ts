// Guard: `browser:`-проверка шага (D-15, оплата DEBT(turn-browser-gate)).
//
// `http:` с 200 не отличает рабочую страницу от пустой: `TypeError` в рантайме
// (`selectedBikeIds.has is not a function`) даёт пустой экран при зелёной сборке.
// `browser:<url>[~маркер]` открывает страницу в headless-браузере, падает на
// ошибках консоли/pageerror, ищет маркер и закрывает страницу в finally.
// Тесты не требуют реального Chromium: лаунчер инжектируется, как fetch у http:.
import { describe, it, expect } from "vitest";
import {
  parseBrowserTarget,
  runBrowserCheck,
  type BrowserProbe,
} from "../../src/modules/execution/browser-check";
import { checkDoneEvidence, parseCheck } from "../../src/modules/execution/plan-checks";
import type { ConsoleEntry } from "../../src/modules/browser/types";

interface FakeProbe extends BrowserProbe {
  readonly closed: boolean;
}

function fakeProbe(overrides: Partial<BrowserProbe> = {}): FakeProbe {
  let closed = false;
  const probe: FakeProbe = {
    get closed() {
      return closed;
    },
    goto: async () => {},
    visibleText: async () => "",
    html: async () => "",
    consoleEntries: () => [],
    close: async () => {
      closed = true;
    },
    ...overrides,
  };
  return probe;
}

function launcherReturning(probe: BrowserProbe) {
  return async () => probe;
}

describe("browser-проверка шага", () => {
  it("парсит url и маркер", () => {
    expect(parseBrowserTarget("http://127.0.0.1:5173/")).toEqual({
      url: "http://127.0.0.1:5173/",
    });
    expect(parseBrowserTarget("http://x/~Каталог")).toEqual({
      url: "http://x/",
      marker: "Каталог",
    });
    expect(parseBrowserTarget("file:///etc/passwd")).toBeNull();
    expect(parseBrowserTarget("  ")).toBeNull();
  });

  it("страница без ошибок и с маркером — ok, страница закрыта", async () => {
    const probe = fakeProbe({
      visibleText: async () => "Каталог: 6 карточек",
      html: async () => "<h1>Каталог</h1>",
    });

    const r = await runBrowserCheck("http://x/~Каталог", {
      launcher: launcherReturning(probe),
    });

    expect(r.ok).toBe(true);
    expect(r.consoleErrors).toBe(0);
    expect(r.markerFound).toBe(true);
    expect(r.line).toBe("ok · 0 console errors · marker found");
    expect(probe.closed).toBe(true);
  });

  it("маркер в HTML (не в видимом тексте) тоже засчитывается", async () => {
    const probe = fakeProbe({
      visibleText: async () => "",
      html: async () => '<div data-testid="catalog"></div>',
    });

    const r = await runBrowserCheck("http://x/~catalog", {
      launcher: launcherReturning(probe),
    });

    expect(r.ok).toBe(true);
    expect(r.markerFound).toBe(true);
  });

  it("console.error и pageerror — отказ с причиной (D-15)", async () => {
    for (const entry of [
      { type: "error", text: "Uncaught TypeError: selectedBikeIds.has is not a function" },
      { type: "pageerror", text: "Page error: selectedBikeIds.has is not a function" },
    ] as ConsoleEntry[]) {
      const probe = fakeProbe({ consoleEntries: () => [entry] });
      const r = await runBrowserCheck("http://x/", { launcher: launcherReturning(probe) });

      expect(r.ok).toBe(false);
      expect(r.consoleErrors).toBe(1);
      expect(String(r.reason)).toContain("selectedBikeIds");
      expect(r.line).toBe("failed · 1 console errors · marker n/a");
      expect(probe.closed).toBe(true);
    }
  });

  it("известный шум консоли не валит проверку", async () => {
    const probe = fakeProbe({
      consoleEntries: () => [
        { type: "log", text: "app started" },
        { type: "error", text: "Download the React DevTools for a better experience" },
        { type: "error", text: "ResizeObserver loop limit exceeded" },
      ],
    });

    const r = await runBrowserCheck("http://x/", { launcher: launcherReturning(probe) });

    expect(r.ok).toBe(true);
    expect(r.consoleErrors).toBe(0);
  });

  it("отсутствующий маркер — отказ", async () => {
    const probe = fakeProbe({ visibleText: async () => "пусто" });
    const r = await runBrowserCheck("http://x/~Каталог", {
      launcher: launcherReturning(probe),
    });

    expect(r.ok).toBe(false);
    expect(r.markerFound).toBe(false);
    expect(String(r.reason)).toContain("marker not found");
    expect(r.line).toBe("failed · 0 console errors · marker not found");
  });

  it("таймаут навигации — отказ, страница всё равно закрыта", async () => {
    const probe = fakeProbe({
      goto: () => new Promise<void>(() => {}),
      visibleText: async () => "никогда",
    });

    const r = await runBrowserCheck("http://x/", {
      launcher: launcherReturning(probe),
      timeoutMs: 20,
    });

    expect(r.ok).toBe(false);
    expect(String(r.reason)).toMatch(/timeout/i);
    expect(probe.closed).toBe(true);
  });

  it("браузер недоступен — отказ с причиной, не fail-open", async () => {
    const r = await runBrowserCheck("http://x/", {
      launcher: async () => {
        throw new Error("Browser unavailable: Chromium is not installed. Run `bunx playwright install chromium`");
      },
    });

    expect(r.ok).toBe(false);
    expect(String(r.reason)).toContain("browser unavailable");
    expect(String(r.reason)).toContain("playwright install chromium");
  });

  it("checkDoneEvidence: browser: проходит и блокирует шаг", async () => {
    const target = { description: "Сделай страницу каталога", check: "browser:http://x/~Каталог" };
    const ok = await checkDoneEvidence(parseCheck("browser:http://x/~Каталог")!, target, 1, {
      browserLauncher: launcherReturning(
        fakeProbe({ visibleText: async () => "Каталог", html: async () => "<h1>Каталог</h1>" }),
      ),
    });
    expect(ok?.blocked).toBeNull();
    expect(String(ok?.note)).toContain("browser check passed");

    const bad = await checkDoneEvidence(parseCheck("browser:http://x/")!, target, 1, {
      browserLauncher: launcherReturning(
        fakeProbe({
          consoleEntries: () => [{ type: "pageerror", text: "Page error: boom" }],
        }),
      ),
    });
    expect(bad?.blocked?.success).toBe(false);
    expect(String(bad?.blocked?.output)).toContain("browser check failed");
    expect(String(bad?.blocked?.output)).toContain("boom");
  });
});
