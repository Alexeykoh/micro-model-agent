/**
 * Adversarial-корпус DLP: «каверзные» утечки, которые не видны построчному
 * матчеру. Гейт — canary-строка не должна появляться в исходящем теле ни в
 * одном варианте; benign-корпус не должен маскироваться.
 *
 * Маска без псевдонимов: так видно сам факт редакции, и token id не мешает
 * проверке на утечку.
 */
import { describe, expect, it } from "vitest";
import { createGuard } from "../../src/modules/security/data-policy/guard";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import type { PolicyContext } from "../../src/modules/security/data-policy/context";
import type { DataPolicyConfig } from "../../src/modules/security/data-policy/types";

const BASE = "C:\\work\\proj";
const CANARY = "CANARY9f3a7b";
const PATH = `${BASE}\\secret\\${CANARY}.txt`;
const SECRET = `sk-${CANARY}0123456789abcdef`;

const ctx: PolicyContext = {
  baseDir: BASE,
  home: "C:\\Users\\alex",
  hostname: "DESKTOP-ABC123",
  username: "alex",
  env: { USERNAME: "alex" },
  workspaceRoots: [],
};

const config: DataPolicyConfig = {
  ...DEFAULT_DATA_POLICY,
  pseudonymize: false,
  pathMode: "prefix",
  // Файл под этим glob скрывается целиком (D2): проверяем, что «каверзное»
  // представление пути не оставляет ни хвоста, ни имени файла.
  providerBlockGlobs: ["secret/**"],
};

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const b64url = (s: string): string =>
  b64(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (s: string): string => Buffer.from(s, "utf8").toString("hex");

/** Тело, которое ушло бы провайдеру (messages + tools), как JSON-строка. */
function outbound(text: string, tools?: unknown[]): string {
  const guard = createGuard({
    config,
    target: { kind: "provider", trusted: false, host: "api.example.com" },
    ctx,
  });
  const result = guard.sanitizeChat([{ role: "user", content: text }], tools);
  return JSON.stringify({ messages: result.messages, tools: result.tools });
}

/** Утечка — canary или корень абсолютного пути (в т.ч. JSON-экранированный). */
function expectNoLeak(text: string, tools?: unknown[]): void {
  const body = outbound(text, tools);
  expect(body, `leak in: ${text.slice(0, 60)}`).not.toContain(CANARY);
  expect(body, `path leak in: ${text.slice(0, 60)}`).not.toMatch(/C:\\\\+work/i);
}

describe("DLP adversarial: каверзные представления одного значения", () => {
  it("raw путь и секрет", () => {
    expectNoLeak(PATH);
    expectNoLeak(`key ${SECRET}`);
  });

  it("в code fence и в JSON-экранировании", () => {
    expectNoLeak("```\n" + PATH + "\n```");
    const escaped = JSON.stringify({ p: PATH }).slice(1, -1);
    expectNoLeak(escaped);
  });

  it("base64 и base64url", () => {
    expectNoLeak(`blob: ${b64(PATH)}`);
    expectNoLeak(`blob: ${b64url(PATH)}`);
    expectNoLeak(`blob: ${b64(SECRET)}`);
  });

  it("hex", () => {
    expectNoLeak(`blob: ${hex(PATH)}`);
  });

  it("percent-encoding, в том числе двойной", () => {
    expectNoLeak(encodeURIComponent(PATH));
    expectNoLeak(encodeURIComponent(encodeURIComponent(PATH)));
  });

  it("split по пробелам, +, переводу строки", () => {
    const head = BASE.slice(0, 8);
    const tail = BASE.slice(8);
    expectNoLeak(`${head} ${tail}\\secret\\${CANARY}.txt`);
    expectNoLeak(`"${head}" + "${tail}\\\\secret\\\\${CANARY}.txt"`);
    expectNoLeak(`${head}\n${tail}\\secret\\${CANARY}.txt`);
  });

  it("нулевая ширина, fullwidth и кириллические гомоглифы", () => {
    expectNoLeak(`${BASE.slice(0, 6)}\u200B${BASE.slice(6)}\\secret\\${CANARY}.txt`);
    // Fullwidth: `Ｃ：＼work＼proj...`.
    const fullwidth = `${BASE}\\secret\\${CANARY}.txt`
      .replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
    expectNoLeak(fullwidth);
    // Гомоглифы: латинские буквы заменены похожими кириллическими.
    const spoofed = `C:\\work\\${"\u0440"}roj\\secret\\${CANARY}.txt`;
    expectNoLeak(spoofed);
  });

  it("секрет, разорванный разделителями и percent-encoding", () => {
    const head = SECRET.slice(0, 10);
    const tail = SECRET.slice(10);
    expectNoLeak(`${head} + "${tail}"`);
    expectNoLeak(encodeURIComponent(`key=${SECRET}`));
  });

  it("путь в описании тула и в аргументах tool_calls", () => {
    const tools = [
      {
        type: "function",
        function: { name: "read_file", description: `reads ${PATH}`, parameters: { type: "object" } },
      },
    ];
    expectNoLeak("hi", tools);
    const call = {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: PATH }) },
        },
      ],
    };
    const guard = createGuard({
      config,
      target: { kind: "provider", trusted: false, host: "api.example.com" },
      ctx,
    });
    const body = JSON.stringify(guard.sanitizeChat([call]).messages);
    expect(body).not.toContain(CANARY);
  });
});

describe("DLP adversarial: benign не маскируется", () => {
  const benign = [
    "hello world, answer is 42",
    "2026-11-02T10:00:00.000Z",
    "550e8400-e29b-41d4-a716-446655440000",
    "visit https://example.com/docs for details",
    "abcdefghijklmnop",
  ];
  for (const text of benign) {
    it(`не трогает: ${text.slice(0, 30)}`, () => {
      expect(outbound(text)).toContain(text);
    });
  }
});
