import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findProjectFavicon, MASCOT_FAVICON } from "../src/modules/webui/favicon";
import { createWebUiState } from "../src/modules/webui/state";
import { withServer, doFetch } from "./helpers/webui-server";

const dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-favicon-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("mma web favicon", () => {
  it("prefers the project's own icon", () => {
    const root = workspace();
    writeFileSync(join(root, "favicon.svg"), "<svg/>");
    const found = findProjectFavicon(root);
    expect(found).not.toBeNull();
    expect(found?.type).toBe("image/svg+xml");
    expect(found?.body.toString()).toBe("<svg/>");
  });

  it("finds an icon in a static/public directory", () => {
    const root = workspace();
    mkdirSync(join(root, "public"));
    writeFileSync(join(root, "public", "favicon.png"), Buffer.from([1, 2, 3]));
    const found = findProjectFavicon(root);
    expect(found?.type).toBe("image/png");
    expect(found?.body.length).toBe(3);
  });

  it("returns null when the project has no icon (mascot fallback)", () => {
    expect(findProjectFavicon(workspace())).toBeNull();
    expect(findProjectFavicon(undefined)).toBeNull();
    // The fallback is a self-contained SVG — no extra asset request.
    expect(MASCOT_FAVICON.startsWith("<svg")).toBe(true);
    expect(MASCOT_FAVICON).toContain("<ellipse");
  });

  it("serves /api/favicon from the workspace and falls back to the mascot", async () => {
    const root = workspace();
    writeFileSync(join(root, "favicon.png"), Buffer.from([9, 8, 7]));
    const s = createWebUiState();
    s.workspace = root;
    await withServer(s, async (base) => {
      const res = await doFetch(base + "/api/favicon");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    });

    const empty = createWebUiState();
    empty.workspace = workspace();
    await withServer(empty, async (base) => {
      const res = await doFetch(base + "/api/favicon");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("image/svg+xml");
      expect(await res.text()).toContain("<svg");
    });
  });
});
