import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWebUiState } from "../src/modules/webui/state";
import { installSkillsEvents, skillsEventPayload } from "../src/modules/webui/skills-events";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("webui: skills SSE forwarding", () => {
  it("installSkillsEvents broadcasts a `skills` event on onChange", () => {
    const state = createWebUiState();
    const chunks: string[] = [];
    state.clients.add({ write: (c: string) => { chunks.push(c); return true; }, end: () => {} } as any);

    let cb: ((loaded: { name: string; kind: string }[]) => void) | null = null;
    const skills = {
      getLoaded: () => [{ name: "git", kind: "builtin" }, { name: "proj", kind: "project" }],
      onChange: (c: (loaded: { name: string; kind: string }[]) => void) => { cb = c; return () => {}; },
    };

    const off = installSkillsEvents(state, skills as any);
    expect(off).toBeTypeOf("function");

    // trigger change
    cb?.([{ name: "git", kind: "builtin" }, { name: "proj", kind: "project" }]);
    const out = chunks.join("");
    expect(out).toContain("event: skills");
    expect(out).toContain('"git"');
    expect(out).toContain('"proj"');
    // safe view only: no content/sourcePath
    expect(out).not.toContain("content");
    expect(out).not.toContain("sourcePath");
  });

  it("installSkillsEvents is a no-op when onChange is absent", () => {
    const state = createWebUiState();
    const chunks: string[] = [];
    state.clients.add({ write: (c: string) => { chunks.push(c); return true; }, end: () => {} } as any);
    const skills = { getLoaded: () => [] };
    const off = installSkillsEvents(state, skills as any);
    expect(off).toBeTypeOf("function");
    expect(chunks.join("")).toBe("");
  });

  it("skillsEventPayload maps kind with fallback", () => {
    const payload = skillsEventPayload({
      getLoaded: () => [{ name: "x" } as any],
    } as any);
    expect(payload.type).toBe("skills");
    expect(payload.skills[0]).toEqual({ name: "x", kind: "global" });
  });
});