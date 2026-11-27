// Канон системного промпта: одна директива — одна строка ≤120 символов.
// Гейт читает РЕАЛЬНЫЙ источник (`system-prompt-render.ts`), а не баррель,
// и проверяет собранный промпт с включённой security (раньше её отключали).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSystemInfo } from "../../src/core/system-prompt-render";
import { DEFAULTS } from "../../src/config/defaults";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SOURCE = readFileSync(
  join(REPO_ROOT, "src", "core", "system-prompt-render.ts"),
  "utf-8",
);

function longLines(text: string): string[] {
  return text
    .split("\n")
    .map((raw, index) => ({ line: raw.replace(/\r$/, ""), index: index + 1 }))
    .filter(({ line }) => line.length > 120)
    .map(({ line, index }) => `${index}: ${line.length} chars`);
}

describe("system prompt line length", () => {
  it("reads the renderer source, not the re-export barrel", () => {
    expect(SOURCE).toContain("You are MMA");
  });

  it("has no source prompt string line longer than 120 characters", () => {
    const long = SOURCE.split("\n")
      .map((raw, index) => ({ line: raw.replace(/\r$/, ""), index: index + 1 }))
      .filter(({ line }) => line.trimStart().startsWith("`") && line.length > 120)
      .map(({ line, index }) => `${index}: ${line.length} chars`);
    expect(long, `Слишком длинные строки промпта: ${long.join("; ")}`).toEqual([]);
  });

  it("keeps the assembled prompt short even with security restrictions on", () => {
    const config = structuredClone(DEFAULTS);
    config.security = {
      ...config.security,
      enabled: true,
      bash: {
        ...config.security.bash,
        enabled: true,
        blacklist: [
          "curl", "wget", "docker", "npm", "pnpm", "yarn", "bun", "git", "python", "node",
          "powershell", "cmd", "ssh", "scp", "rsync",
        ],
        whitelist: [],
        blockDangerousFlags: true,
      },
    };
    const prompt = buildSystemInfo(config, "/tmp", "win32 shell=cmd", undefined, "full");
    expect(longLines(prompt)).toEqual([]);
  });
});
