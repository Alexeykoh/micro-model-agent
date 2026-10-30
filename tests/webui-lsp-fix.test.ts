// LSP "fix": diagnostics become one agent prompt, not a dead-end list. The
// button lives in the frontend, so this guards the prompt shape and the hook
// hand-off (the backend only knows about raw diagnostics).
import { beforeEach, describe, expect, it } from "vitest";
import { setupHappyDom } from "./helpers/happy-dom";

setupHappyDom();

const fix = await import("../src/modules/webui/assets/js/sidebar/lsp-fix.js");
const { hooks } = await import("../src/modules/webui/assets/js/store.js");
const { I18N } = await import("../src/modules/webui/assets/js/i18n.js");

beforeEach(() => {
  I18N.locale = "en";
  I18N.dicts = {
    en: {
      "web.sidebar.lsp_fix_prompt": "Fix these in {path}:\n{problems}\nThen verify.",
    },
  };
  hooks.askAgent = null;
});

describe("lsp-fix", () => {
  it("formats one line per diagnostic with position and severity", () => {
    const text = fix.formatDiagnostics([
      { line: 3, column: 7, severity: "error", message: "cannot find name" },
      { line: 9, severity: "warning", message: "unused\nvariable" },
    ]);
    expect(text).toBe("- 3:7 [error] cannot find name\n- 9:1 [warning] unused variable");
  });

  it("builds a prompt with the path and every problem", () => {
    const prompt = fix.fixPrompt("src/a.ts", [
      { line: 1, column: 2, severity: "error", message: "boom" },
    ]);
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("- 1:2 [error] boom");
    expect(prompt).toContain("Then verify.");
  });

  it("hands the prompt to the composer hook instead of dropping it", () => {
    const seen: string[] = [];
    hooks.askAgent = (text) => seen.push(text);
    fix.fixDiagnostics("src/b.ts", [{ line: 2, severity: "error", message: "nope" }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("src/b.ts");
    expect(seen[0]).toContain("nope");
  });

  it("does nothing when there is no file or no diagnostics", () => {
    const seen: string[] = [];
    hooks.askAgent = (text) => seen.push(text);
    fix.fixDiagnostics("", [{ line: 1, message: "x" }]);
    fix.fixDiagnostics("src/c.ts", []);
    expect(seen).toHaveLength(0);
  });
});
