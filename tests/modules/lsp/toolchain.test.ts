// Детект тулчейна проекта: версии рантаймов/пакетов по стандартным манифестам —
// для всех языков, не только JS (ключевой кейс: Angular 11 на Node 16).
import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { detectProjectToolchain } from "../../../src/modules/lsp/toolchain";

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-tc-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("detectProjectToolchain", () => {
  it("reads node + typescript + angular from a legacy JS project", () => {
    const dir = project({
      ".nvmrc": "16.13.0\n",
      "package.json": JSON.stringify({
        dependencies: { "@angular/core": "^11.2.0" },
        devDependencies: { typescript: "~4.1.6" },
        engines: { node: ">=16 <17" },
      }),
    });
    const tc = detectProjectToolchain(dir);
    expect(tc.runtimes.find((r) => r.name === "node")?.version).toBe("16.13.0");
    expect(tc.packages["typescript"]).toBe("4.1.6");
    expect(tc.packages["@angular/core"]).toBe("11.2.0");
  });

  it("reads node from package.json engines when no .nvmrc", () => {
    const dir = project({ "package.json": JSON.stringify({ engines: { node: ">=20" } }) });
    const tc = detectProjectToolchain(dir);
    expect(tc.runtimes.find((r) => r.name === "node")).toMatchObject({
      version: "20",
      source: "package.json#engines.node",
    });
  });

  it("reads python, rust, go, ruby, php and dotnet versions", () => {
    const dir = project({
      ".python-version": "3.11.5",
      "rust-toolchain.toml": '[toolchain]\nchannel = "1.65.0"\n',
      "go.mod": "module x\n\ngo 1.20\n",
      ".ruby-version": "3.2.2",
      "composer.json": JSON.stringify({ require: { php: ">=8.1" } }),
      "global.json": JSON.stringify({ sdk: { version: "7.0.400" } }),
    });
    const tc = detectProjectToolchain(dir);
    const v = (name: string) => tc.runtimes.find((r) => r.name === name)?.version;
    expect(v("python")).toBe("3.11.5");
    expect(v("rust")).toBe("1.65.0");
    expect(v("go")).toBe("1.20");
    expect(v("ruby")).toBe("3.2.2");
    expect(v("php")).toBe("8.1");
    expect(v("dotnet")).toBe("7.0.400");
  });

  it("returns an empty toolchain for an unknown directory", () => {
    const tc = detectProjectToolchain(project({}));
    expect(tc.runtimes).toEqual([]);
    expect(tc.packages).toEqual({});
  });
});
