// Пути установки: резолв `mma` в PATH, классификация запуска и теневой резолв.
// Герметично: временные каталоги, без спавна процессов.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkPathShadowing,
  classifyInstall,
  isUnder,
  resolveOnPath,
} from "../../src/core/install-path";

const isWin = process.platform === "win32";
const DELIM = isWin ? ";" : ":";

let work = "";

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "mma-install-path-"));
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

/** Команда `mma` с правильным для платформы расширением. */
function writeMma(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, isWin ? "mma.cmd" : "mma");
  writeFileSync(file, isWin ? "@echo off\r\n" : "#!/bin/sh\n");
  if (!isWin) chmodSync(file, 0o755);
  return file;
}

describe("resolveOnPath", () => {
  it("берёт первое совпадение в порядке PATH", () => {
    const first = join(work, "first");
    const second = join(work, "second");
    const firstMma = writeMma(first);
    writeMma(second);
    const found = resolveOnPath("mma", `${first}${DELIM}${second}`);
    expect(found).toBe(resolve(firstMma));
  });

  it("пропускает каталоги без команды", () => {
    const empty = join(work, "empty");
    const withMma = join(work, "with-mma");
    mkdirSync(empty, { recursive: true });
    const mma = writeMma(withMma);
    expect(resolveOnPath("mma", `${empty}${DELIM}${withMma}`)).toBe(resolve(mma));
  });

  it("возвращает null, когда команды нет", () => {
    expect(resolveOnPath("mma", join(work, "nowhere"))).toBeNull();
  });
});

describe("classifyInstall", () => {
  const root = join(work, "home", ".mma");
  const npmPrefix = join(work, "npm");

  it("release — entry под install root", () => {
    expect(classifyInstall(join(root, "current", "app", "main.js"), root)).toBe("release");
  });

  it("dev — TypeScript-исходник", () => {
    expect(classifyInstall(join(work, "repo", "src", "cli", "main.ts"), root)).toBe("dev");
  });

  it("npm — entry под npm-prefix или в node_modules", () => {
    expect(classifyInstall(join(npmPrefix, "mma.cmd"), root, npmPrefix)).toBe("npm");
    expect(
      classifyInstall(
        join(work, "lib", "node_modules", "micro-models-agent", "bin", "mma.mjs"),
        root,
      ),
    ).toBe("npm");
  });

  it("other — всё остальное", () => {
    expect(classifyInstall(join(work, "opt", "tool", "main.js"), root)).toBe("other");
  });
});

describe("checkPathShadowing", () => {
  it("своя установка в PATH — не тень", () => {
    const root = join(work, "shadow-ok", ".mma");
    const bin = join(root, "bin");
    writeMma(bin);
    const result = checkPathShadowing(root, bin);
    expect(result.resolved).not.toBeNull();
    expect(result.shadowed).toBe(false);
  });

  it("чужой mma в PATH — тень с абсолютным путём", () => {
    const root = join(work, "shadow-bad", ".mma");
    const foreign = join(work, "shadow-bad", "npm");
    const file = writeMma(foreign);
    const result = checkPathShadowing(root, foreign);
    expect(result.shadowed).toBe(true);
    expect(result.resolved).toBe(resolve(file));
  });

  it("пустой PATH — не тень", () => {
    expect(checkPathShadowing(join(work, "x", ".mma"), "")).toEqual({
      resolved: null,
      shadowed: false,
    });
  });
});

describe("isUnder", () => {
  it("совпадение и вложенность", () => {
    expect(isUnder(join(work, "a", "b"), join(work, "a"))).toBe(true);
    expect(isUnder(join(work, "a", "b"), join(work, "a", "b"))).toBe(true);
    expect(isUnder(join(work, "ab"), join(work, "a"))).toBe(false);
  });
});
