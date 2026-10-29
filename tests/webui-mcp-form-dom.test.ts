// B-37: MCP form UX. Validation is inline (inside the form, next to Save), the
// command/url field follows the transport, and an empty transport is an explicit
// error rather than a silent "stdio".
import { describe, it, expect } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

const win = setupHappyDom('<div id="saveIndicator" role="status" aria-live="polite"></div>');
const { mcpForm } = await import("../src/modules/webui/assets/js/settings/mcp-form.js");
const { settings } = await import("../src/modules/webui/assets/js/store.js");

type Dict = Record<string, unknown>;

function render(entry: Dict | null = null): HTMLElement {
  settings.mcpForm = { mode: entry ? "edit" : "add", entry };
  const form = mcpForm();
  document.body.appendChild(form);
  return form;
}

function field(form: HTMLElement, label: string): HTMLElement {
  const nodes = Array.from(form.querySelectorAll<HTMLElement>(".pform-field"));
  const found = nodes.find((n) => n.querySelector("label")?.textContent === label);
  if (!found) throw new Error(`field not found: ${label}`);
  return found;
}

function transport(form: HTMLElement): HTMLSelectElement {
  return field(form, "transport").querySelector("select") as HTMLSelectElement;
}

function clickSave(form: HTMLElement): void {
  const save = form.querySelector<HTMLElement>(".pform-actions .linkbtn");
  if (!save) throw new Error("save button not found");
  save.click();
}

function stubFetch(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const tick = (): Promise<void> => new Promise((r) => win.setTimeout(r, 10));

describe("MCP form: inline validation (B-37)", () => {
  it("renders an aria-live error inside the form and never a header toast", async () => {
    const fetchStub = stubFetch();
    try {
      const form = render();
      const error = form.querySelector<HTMLElement>(".pform-error");
      expect(error).toBeTruthy();
      expect(form.contains(error)).toBe(true);
      expect(error?.hidden).toBe(true);
      expect(error?.getAttribute("aria-live")).toBe("polite");

      clickSave(form); // name and command are empty
      await tick();

      expect(error?.hidden).toBe(false);
      expect(error?.textContent?.trim()).not.toBe("");
      // The header toast (#saveIndicator) stays untouched for validation.
      expect(win.document.getElementById("saveIndicator")?.textContent).toBe("");
      expect(fetchStub.calls).toEqual([]);
    } finally {
      fetchStub.restore();
    }
  });

  it("clears the inline error on edit", async () => {
    const fetchStub = stubFetch();
    try {
      const form = render();
      clickSave(form);
      await tick();
      const error = form.querySelector<HTMLElement>(".pform-error");
      expect(error?.hidden).toBe(false);

      const name = field(form, "name").querySelector("input") as HTMLInputElement;
      name.value = "srv";
      name.dispatchEvent(new win.Event("input", { bubbles: true }));
      expect(error?.hidden).toBe(true);
      expect(error?.textContent).toBe("");
    } finally {
      fetchStub.restore();
    }
  });
});

describe("MCP form: transport-aware fields (B-37)", () => {
  it("shows command for stdio and url for sse/http", () => {
    const fetchStub = stubFetch();
    try {
      const form = render();
      const sel = transport(form);
      const command = field(form, "command");
      const url = field(form, "url");

      expect(sel.querySelector('option[value=""]')).toBeNull();
      expect(command.hidden).toBe(false);
      expect(url.hidden).toBe(true);

      sel.value = "sse";
      sel.dispatchEvent(new win.Event("change", { bubbles: true }));
      expect(command.hidden).toBe(true);
      expect(url.hidden).toBe(false);

      sel.value = "http";
      sel.dispatchEvent(new win.Event("change", { bubbles: true }));
      expect(command.hidden).toBe(true);
      expect(url.hidden).toBe(false);

      sel.value = "stdio";
      sel.dispatchEvent(new win.Event("change", { bubbles: true }));
      expect(command.hidden).toBe(false);
      expect(url.hidden).toBe(true);
    } finally {
      fetchStub.restore();
    }
  });

  it("rejects an empty transport explicitly instead of sending stdio", async () => {
    const fetchStub = stubFetch();
    try {
      const form = render();
      const sel = transport(form);
      // Simulate a hand-edited/legacy DOM value (the rendered select has none).
      const empty = document.createElement("option");
      empty.value = "";
      sel.appendChild(empty);
      sel.value = "";

      const name = field(form, "name").querySelector("input") as HTMLInputElement;
      const command = field(form, "command").querySelector("input") as HTMLInputElement;
      name.value = "srv";
      command.value = "npx";

      clickSave(form);
      await tick();

      const error = form.querySelector<HTMLElement>(".pform-error");
      expect(error?.hidden).toBe(false);
      expect(error?.textContent?.trim()).not.toBe("");
      expect(fetchStub.calls).toEqual([]);
    } finally {
      fetchStub.restore();
    }
  });
});
