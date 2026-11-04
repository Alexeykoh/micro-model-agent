// A5 (INV-W8, спека 2026-11-04-webui-latency-design): индикатор записи
// переключателя. Статичный `⋯` не отвечает на вопрос «зависло?» — через
// секунду на подписи появляется счётчик ожидания, а `aria-busy` честен
// для скринридера.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom(
  `<div class="selectors"><div class="sel"><button class="pending" aria-busy="true"><b>Model</b></button></div></div>`,
);

const pending = await import("../src/modules/webui/assets/js/settings/pending-wait.js");

function button(): HTMLElement {
  const el = win.document.querySelector<HTMLElement>(".sel > button");
  if (!el) throw new Error("нет кнопки селектора");
  return el;
}

function label(): HTMLElement {
  const el = win.document.querySelector<HTMLElement>(".sel > button b");
  if (!el) throw new Error("нет подписи селектора");
  return el;
}

beforeEach(() => {
  button().classList.add("pending");
});

afterEach(() => {
  // Снимаем pending и сбрасываем накопленное состояние модуля: без pending
  // `paintPendingWait` гасит таймер и очищает счётчик.
  button().classList.remove("pending");
  pending.paintPendingWait();
  vi.restoreAllMocks();
});

describe("selector wait counter (A5)", () => {
  it("shows no counter during the first second — the spinner is enough", () => {
    pending.initPendingWait();
    expect(label().dataset.wait).toBeUndefined();
  });

  it("shows elapsed seconds once the write crosses a second", () => {
    const base = 1_700_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(base);
    pending.initPendingWait();
    expect(label().dataset.wait).toBeUndefined();

    now.mockReturnValue(base + pending.WAIT_SHOW_AFTER_MS + 500);
    pending.paintPendingWait();
    expect(label().dataset.wait).toBe("1s");

    now.mockReturnValue(base + 3_500);
    pending.paintPendingWait();
    expect(label().dataset.wait).toBe("3s");
  });

  it("drops the counter when the write finishes", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    pending.initPendingWait();
    now.mockReturnValue(1_700_000_005_000);
    pending.paintPendingWait();
    expect(label().dataset.wait).toBe("5s");

    win.document.querySelector("button")?.classList.remove("pending");
    pending.paintPendingWait();
    expect(label().dataset.wait).toBeUndefined();
  });
});
