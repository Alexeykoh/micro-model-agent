// Switching providers must refresh the web sidebar's usage projection:
// the provider row reads it, the SSE config event re-reads active state,
// and the backend exposes the live context probe (not only the boot promise).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  readFileSync(new URL(`../src/modules/webui/assets/${rel}`, import.meta.url), "utf8");
const readModule = (): string =>
  readFileSync(new URL("../src/modules/webui/module.ts", import.meta.url), "utf8");

describe("provider switch usage refresh", () => {
  it("renders the provider in Сессия · Использование", () => {
    const src = read("js/feed/sidebar.ts");
    expect(src).toContain('t("web.usage.provider")');
    expect(src).toContain('t("web.usage.provider_unavailable")');
    expect(src).toContain("h.providerReachable === false");
  });

  it("refreshes the active sidebar projection after a config event", () => {
    expect(read("js/sse.ts")).toContain("void refreshSidebar?.()");
    expect(read("app.ts")).toContain("refreshSidebar: refresh");
  });

  it("reads the live context probe from the agent after a switch", () => {
    const src = readModule();
    expect(src).toContain("agent.contextProbeSnapshot");
    expect(src).toContain("contextProbe: currentContextProbe()");
    expect(src).toContain("live === undefined ? probe : live");
  });
});