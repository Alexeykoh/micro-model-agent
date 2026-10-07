// Real DOM coverage for the settings control layer's dynamic <select> editor.
// `bun test` doesn't apply vitest's environment docblock, so happy-dom is wired
// manually (mirrors webui-sidebar-dom.test.ts).
import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.location = win.location;
g.localStorage = win.localStorage;

const { controlFor } = await import("../src/modules/webui/assets/js/settings/controls.js");

type Dict = Record<string, unknown>;

function ctx(over: Dict = {}): Dict {
  return {
    label: "x",
    enumLabel: (v: string) => v,
    emptyLabel: "—",
    modelOptions: [],
    providerOptions: [],
    fieldLabel: (k: string) => k,
    post: () => {},
    ...over,
  };
}

const modelDef = {
  key: "orchestrator.model",
  valueType: "string",
  editor: { kind: "select", optionsSource: "models" },
};

describe("settings controlFor: select editor", () => {
  it("renders a dropdown from the live model list with an empty option", () => {
    const node = controlFor(modelDef, "", ctx({ modelOptions: ["m1", "m2"] })) as HTMLSelectElement;
    expect(node.tagName).toBe("SELECT");
    const values = [...node.querySelectorAll("option")].map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(["", "m1", "m2"]);
  });

  it("selects the current value", () => {
    const node = controlFor(modelDef, "m2", ctx({ modelOptions: ["m1", "m2"] })) as HTMLSelectElement;
    expect(node.value).toBe("m2");
  });

  it("keeps a stored-but-unknown value selectable", () => {
    const node = controlFor(modelDef, "legacy", ctx({ modelOptions: ["m1"] })) as HTMLSelectElement;
    expect(node.value).toBe("legacy");
  });

  it("posts the picked value (and empty for the default option)", () => {
    let posted: unknown = "unset";
    const node = controlFor(modelDef, "", ctx({ modelOptions: ["m1"], post: (v: unknown) => (posted = v) })) as HTMLSelectElement;
    node.value = "m1";
    node.dispatchEvent(new win.Event("change"));
    expect(posted).toBe("m1");
    node.value = "";
    node.dispatchEvent(new win.Event("change"));
    expect(posted).toBe("");
  });

  it("falls back to a text input when no options are available", () => {
    const node = controlFor(modelDef, "typed", ctx()) as HTMLInputElement;
    expect(node.tagName).toBe("INPUT");
    expect(node.value).toBe("typed");
  });

  it("uses provider options for a providers source", () => {
    const def = {
      key: "critic.provider",
      valueType: "string",
      editor: { kind: "select", optionsSource: "providers" },
    };
    const node = controlFor(def, "judge", ctx({ providerOptions: ["local", "judge"] })) as HTMLSelectElement;
    expect(node.value).toBe("judge");
  });

  it("renders a model select inside the experts table editor", () => {
    const def = {
      key: "experts",
      valueType: "json",
      editor: { kind: "table", columns: [{ key: "name" }, { key: "model", optionsSource: "models" }] },
    };
    const node = controlFor(def, { code: { model: "m1", tool_tags: ["code"] } }, ctx({ modelOptions: ["m1", "m2"] }));
    const sel = node.querySelector("select") as HTMLSelectElement;
    expect(sel).toBeTruthy();
    expect(sel.value).toBe("m1");
  });
});
