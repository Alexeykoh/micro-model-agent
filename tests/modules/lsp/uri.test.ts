import { describe, expect, it } from "vitest";
import { pathToUri, uriToPath } from "../../../src/modules/lsp/uri";

describe("pathToUri / uriToPath", () => {
  it("round-trips a POSIX path", () => {
    const p = "/home/user/project/src/a.ts";
    expect(pathToUri(p)).toBe(`file://${p}`);
    expect(uriToPath(pathToUri(p))).toBe(p);
  });

  it("round-trips a Windows path", () => {
    const p = "C:\\projects\\mma\\src\\a.ts";
    const uri = pathToUri(p);
    expect(uri).toBe("file:///C:/projects/mma/src/a.ts");
    expect(uriToPath(uri)).toBe("C:/projects/mma/src/a.ts");
  });

  it("round-trips paths with spaces", () => {
    const p = "C:\\Users\\Alexe\\My Documents\\project\\a.ts";
    const uri = pathToUri(p);
    expect(uri).toBe("file:///C:/Users/Alexe/My%20Documents/project/a.ts");
    expect(uriToPath(uri)).toBe("C:/Users/Alexe/My Documents/project/a.ts");
  });

  it("round-trips percent, hash and question marks", () => {
    const p = "C:\\p\\100%\\a#b?c.ts";
    const uri = pathToUri(p);
    expect(uri).toContain("100%25");
    expect(uri).toContain("a%23b%3Fc.ts");
    // Разделители приводятся к `/` (так их ждут LSP-серверы) — байты те же.
    expect(uriToPath(uri)).toBe("C:/p/100%/a#b?c.ts");
  });

  it("round-trips non-ASCII segments", () => {
    const p = "C:\\проекты\\модели\\a.ts";
    const uri = pathToUri(p);
    expect(uri).toBe("file:///C:/%D0%BF%D1%80%D0%BE%D0%B5%D0%BA%D1%82%D1%8B/%D0%BC%D0%BE%D0%B4%D0%B5%D0%BB%D0%B8/a.ts");
    expect(uriToPath(uri)).toBe("C:/проекты/модели/a.ts");
  });

  it("decodes a URI the server would produce", () => {
    expect(uriToPath("file:///c:/x%20y/a.ts")).toBe("c:/x y/a.ts");
    expect(uriToPath("file:///home/a.ts")).toBe("/home/a.ts");
  });

  it("keeps a POSIX path distinguishable from a Windows drive", () => {
    expect(pathToUri("C:/a/b.ts")).toBe("file:///C:/a/b.ts");
    expect(pathToUri("/home/a/b.ts")).toBe("file:///home/a/b.ts");
    // Ключевое: круг не съедает ведущий слэш у posix-пути.
    expect(uriToPath(pathToUri("/home/a/b.ts"))).toBe("/home/a/b.ts");
    expect(uriToPath(pathToUri("C:/a/b.ts"))).toBe("C:/a/b.ts");
  });
});
