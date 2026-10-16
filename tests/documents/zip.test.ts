import { describe, expect, it } from "vitest";
import { readZip, readZipText } from "../../src/modules/documents/handlers/zip";
import { buildZip } from "./fixtures-zip";

describe("readZip", () => {
  it("извлекает stored и deflated записи", () => {
    const zip = readZip(
      buildZip([
        { name: "a.txt", data: "hello" },
        { name: "dir/b.txt", data: "world world world", deflate: true },
      ]),
    );
    expect(new TextDecoder().decode(zip.get("a.txt")!)).toBe("hello");
    expect(readZipText(zip, "dir/b.txt")).toBe("world world world");
  });

  it("deflate сжимает длинный текст, но данные побайтово равны исходным", () => {
    const text = "line\n".repeat(500);
    const zip = readZip(buildZip([{ name: "big.txt", data: text, deflate: true }]));
    expect(readZipText(zip, "big.txt")).toBe(text);
  });

  it("отсутствующая запись → undefined", () => {
    const zip = readZip(buildZip([{ name: "a.txt", data: "x" }]));
    expect(readZipText(zip, "nope")).toBeUndefined();
  });

  it("порченый ввод → понятная ошибка", () => {
    expect(() => readZip(new Uint8Array([1, 2, 3, 4]))).toThrow(/ZIP/i);
  });
});
