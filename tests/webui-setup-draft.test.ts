// Черновик визарда: переживает перезагрузку, не содержит API-ключа и чистится.
import { describe, it, expect, beforeEach } from "vitest";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.localStorage = win.localStorage;

const { createSetupState, stepIndex } = await import("../src/modules/webui/assets/setup-state.js");
const { saveDraft, loadDraft, clearDraft } =
  await import("../src/modules/webui/assets/setup-draft.js");

beforeEach(() => {
  clearDraft();
  win.localStorage.clear();
});

describe("setup draft", () => {
  it("saves step and answers but never the API key", () => {
    const state = createSetupState();
    state.step = stepIndex("model");
    state.answers.apiKey = "sk-secret";
    state.answers.model = "qwen/qwen3.5-9b";
    saveDraft(state);

    const raw = win.localStorage.getItem("mma-setup-draft-v1");
    expect(raw).not.toContain("sk-secret");
    const draft = loadDraft();
    expect(draft?.step).toBe(stepIndex("model"));
    expect(draft?.answers.model).toBe("qwen/qwen3.5-9b");
    expect(draft?.answers.apiKey).toBeUndefined();
  });

  it("clamps a corrupted step and rejects a foreign version", () => {
    const state = createSetupState();
    state.step = 999;
    saveDraft(state);
    expect(loadDraft()?.step).toBeLessThan(999);

    win.localStorage.setItem("mma-setup-draft-v1", JSON.stringify({ v: 2, step: 1, answers: {} }));
    expect(loadDraft()).toBeNull();
  });

  it("clear removes the draft", () => {
    const state = createSetupState();
    saveDraft(state);
    clearDraft();
    expect(loadDraft()).toBeNull();
  });
});
