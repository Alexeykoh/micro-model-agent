// Текст отказа установки (STYLE.md): одна причина человеческим языком и одна
// команда, которая действительно чинит ситуацию. Сырой `EACCES: … rm '…'`
// остаётся диагностикой, а не текстом ошибки в чате.
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../src/i18n/index";
import {
  classifyInstallError,
  installFailureText,
  shortCause,
  tildePath,
} from "../src/modules/updater/messages";
import { homedir } from "node:os";
import { join } from "node:path";

afterEach(() => setLocale("en"));

describe("classifyInstallError", () => {
  it("maps a permission error to the install root, without the raw rm line", () => {
    const cause = classifyInstallError(
      "EACCES: permission denied, rm 'C:\\Users\\u\\.mma\\versions\\0.10.1'",
      join(homedir(), ".mma"),
    );
    expect(cause).toMatch(/write permission|прав на запись/);
    expect(cause).toContain("~");
    expect(cause).not.toContain("rm '");
  });

  it("distinguishes a corrupted download from an unreachable server", () => {
    expect(classifyInstallError("checksum mismatch (expected a, got b)", "/r")).toMatch(
      /corrupted|повреждено/,
    );
    expect(classifyInstallError("size mismatch (expected 1, got 2)", "/r")).toMatch(
      /corrupted|повреждено/,
    );
    expect(classifyInstallError("manifest HTTP 503", "/r")).toMatch(/unreachable|недоступен/);
    expect(classifyInstallError("manifest HTTP 404", "/r")).toMatch(/not found|не найден/);
  });

  it("keeps an unknown cause short and on one line", () => {
    const raw = `weird thing happened\nat Object.<anonymous> (${"/x".repeat(200)})`;
    expect(classifyInstallError(raw, "/r")).toBe(shortCause(raw));
    expect(shortCause(raw)).not.toContain("\n");
    expect(shortCause(raw).length).toBeLessThanOrEqual(160);
  });

  it("keeps paths outside the home directory untouched", () => {
    expect(tildePath("/opt/mma")).toBe("/opt/mma");
    expect(tildePath(join(homedir(), ".mma"))).toBe("~/.mma");
  });
});

describe("installFailureText", () => {
  it("renders two lines: the cause and one actionable reinstall command", () => {
    const text = installFailureText("0.12.2", "manifest HTTP 503", "/home/u/.mma", "linux");
    const [what, hint, ...extra] = text.split("\n");
    expect(extra).toEqual([]);
    expect(what).not.toContain("[updater]");
    expect(what).toContain("0.12.2");
    expect(hint.startsWith("↳ ")).toBe(true);
    expect(hint).toContain("install.sh");
  });

  it("points Windows users at the PowerShell installer", () => {
    const hint = installFailureText("1.0.0", "http 404", "/r", "win32").split("\n")[1];
    expect(hint).toContain("install.ps1");
  });

  it("omits the version when the manifest never told us one", () => {
    const [what] = installFailureText("", "manifest HTTP 503", "/r", "linux").split("\n");
    expect(what).toMatch(/MMA/);
    expect(what).not.toMatch(/ {2,}|—\s+\./);
  });

  it("has a Russian variant with the same shape", () => {
    setLocale("ru");
    const [what, hint] = installFailureText("0.12.2", "checksum mismatch", "/r").split("\n");
    expect(what).toMatch(/Не удалось обновить/);
    expect(what).toMatch(/повреждено/);
    expect(hint.startsWith("↳ ")).toBe(true);
  });
});
