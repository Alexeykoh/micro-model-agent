import { describe, expect, it } from "vitest";
import { formatDoctor } from "../../../src/cli/repl-commands-lsp";
import { setLocale } from "../../../src/i18n/index";
import type { LspDiagnosis } from "../../../src/modules/lsp/diagnose";

/**
 * `/lsp doctor` обязан называть причину, а не выдавать «ок» рядом с падающим
 * сервером: строка версии Node в шапке, класс `node-too-old` и хвост stderr
 * упавшего сервера. Без этого пользователь видит «doctor ok» + «сервер ещё
 * запускается» и не знает, что дело в Node 16.
 */

setLocale("en");

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

function diagnosis(overrides: Partial<LspDiagnosis> = {}): LspDiagnosis {
  return {
    enabled: true,
    offline: false,
    projectRoot: "C:/proj",
    nodeVersion: { raw: "v16.20.2", major: 16 },
    servers: [
      {
        language: "typescript",
        command: "npx",
        args: [],
        enabled: true,
        applicable: true,
        autoInstall: true,
        probed: true,
        ok: false,
        reason: "node-too-old",
        error: "LSP server exited",
        stderrTail: "SyntaxError: Unexpected token '?'\n    at wrapSafe\n    at Module._compile",
        installCommand: "npm i -g typescript-language-server@3.3.2 typescript@5",
      },
    ],
    ...overrides,
  };
}

describe("/lsp doctor", () => {
  it("shows the Node version in the header", () => {
    const lines = formatDoctor(diagnosis()).map(stripAnsi);
    expect(lines.some((l) => l.includes("Node") && l.includes("v16.20.2"))).toBe(true);
  });

  it("renders the crash class, stderr tail and a pinned install command", () => {
    const text = formatDoctor(diagnosis()).map(stripAnsi).join("\n");
    expect(text).toContain("Node too old for this server");
    expect(text).toContain("server stderr: SyntaxError: Unexpected token '?'");
    expect(text).toContain("typescript-language-server@3.3.2");
    expect(text).toContain("crashes on startup");
  });

  it("caps the stderr tail to three lines", () => {
    const text = formatDoctor(diagnosis()).map(stripAnsi).join("\n");
    expect(text).toContain("at wrapSafe");
    expect(text).toContain("at Module._compile");
    expect(text).not.toContain("node:internal");
  });

  it("omits the Node line when the version is unknown", () => {
    const lines = formatDoctor(diagnosis({ nodeVersion: undefined })).map(stripAnsi);
    expect(lines.some((l) => l.includes("v16.20.2"))).toBe(false);
  });
});
