import { describe, expect, it } from "vitest";
import {
  MAX_FRAME_BYTES,
  findHeaderEnd,
  isAcceptableFrameLength,
  parseContentLength,
} from "../../../src/modules/lsp/framing";

const frame = (body: string, eol = "\r\n", extra = ""): string =>
  `Content-Length: ${byteLength(body)}${extra}${eol}${eol}${body}`;

const byteLength = (s: string): number => Buffer.byteLength(s, "utf8");

describe("findHeaderEnd", () => {
  it("accepts CRLF separator", () => {
    const buf = Buffer.from("Content-Length: 2\r\n\r\n{}");
    expect(findHeaderEnd(buf)).toEqual({ headerEnd: 21, headerLength: 4 });
  });

  it("accepts LF separator", () => {
    const buf = Buffer.from("Content-Length: 2\n\n{}");
    const res = findHeaderEnd(buf);
    expect(res?.headerEnd).toBe(19);
  });

  it("accepts mixed separator", () => {
    const buf = Buffer.from("Content-Length: 2\r\n\n{}");
    expect(findHeaderEnd(buf)?.headerEnd).toBe(20);
  });

  it("returns null when headers are incomplete", () => {
    expect(findHeaderEnd(Buffer.from("Content-Length: 2\r\n"))).toBeNull();
    expect(findHeaderEnd(Buffer.alloc(0))).toBeNull();
    expect(findHeaderEnd(Buffer.from("Content-Length"))).toBeNull();
  });
});

describe("parseContentLength", () => {
  it("parses a plain header", () => {
    expect(parseContentLength("Content-Length: 42")).toBe(42);
  });

  it("is case and whitespace tolerant", () => {
    expect(parseContentLength("content-length:42")).toBe(42);
    expect(parseContentLength("  CONTENT-LENGTH :  42  ")).toBe(42);
  });

  it("skips unrelated headers", () => {
    expect(parseContentLength("Content-Type: application/vscode-jsonrpc\r\nContent-Length: 7")).toBe(7);
  });

  it("rejects non-numeric values", () => {
    expect(parseContentLength("Content-Length: abc")).toBeNull();
    expect(parseContentLength("Content-Length:")).toBeNull();
    expect(parseContentLength("Content-Type: x")).toBeNull();
  });
});

describe("isAcceptableFrameLength", () => {
  it("accepts normal sizes", () => {
    expect(isAcceptableFrameLength(0)).toBe(true);
    expect(isAcceptableFrameLength(1024)).toBe(true);
    expect(isAcceptableFrameLength(MAX_FRAME_BYTES)).toBe(true);
  });

  it("rejects negative, fractional and oversized lengths", () => {
    expect(isAcceptableFrameLength(-1)).toBe(false);
    expect(isAcceptableFrameLength(1.5)).toBe(false);
    expect(isAcceptableFrameLength(MAX_FRAME_BYTES + 1)).toBe(false);
    expect(isAcceptableFrameLength(Number.NaN)).toBe(false);
  });
});

describe("frames", () => {
  it("declares length in bytes, not characters", () => {
    // Кириллица: 2 байта на символ — число в заголовке ≠ числу JS-символов.
    const body = '{"m":"привет"}';
    const raw = frame(body);
    const buf = Buffer.from(raw);
    const headerEnd = Buffer.from(raw.slice(0, findHeaderEnd(buf)!.headerEnd)).toString();
    expect(parseContentLength(headerEnd)).toBe(byteLength(body));
    expect(byteLength(body)).toBeGreaterThan(body.length);
  });
});
