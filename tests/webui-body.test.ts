import { describe, it, expect } from "vitest";
import { createWebUiState } from "../src/modules/webui/state";
import { parseJsonBody } from "../src/modules/webui/body";
import { DEFAULTS } from "../src/config/defaults";
import { doFetch, postJson, withServer } from "./helpers/webui-server";

describe("parseJsonBody", () => {
  it("parses a valid object", () => {
    expect(parseJsonBody('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns null on malformed JSON", () => {
    expect(parseJsonBody("{not json")).toBeNull();
    expect(parseJsonBody("")).toBeNull();
  });

  it("maps valid non-object JSON to {} so endpoint validation rejects it", () => {
    expect(parseJsonBody('"str"')).toEqual({});
    expect(parseJsonBody("42")).toEqual({});
    expect(parseJsonBody("null")).toEqual({});
  });
});

describe("readJsonBody integration", () => {
  it("POST /api/config with malformed JSON answers 400 invalid JSON", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS);
    await withServer(s, async (base) => {
      const bad = await doFetch(`${base}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ ok: false, error: "invalid JSON" });
    });
  });

  it("POST /api/config with non-object JSON answers endpoint validation, not a crash", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS);
    await withServer(s, async (base) => {
      const { status, json } = await postJson(base, "/api/config", 42);
      expect(status).toBe(400);
      expect(json.ok).toBe(false);
    });
  });
});
