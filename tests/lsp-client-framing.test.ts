import { describe, it, expect } from "vitest";
import { LspConnection } from "../src/modules/lsp/connection";

/**
 * Byte-accurate framing: `Content-Length` считает БАЙТЫ, поэтому тело с
 * многобайтным UTF-8, разрезанное между чанками, обязано собираться без
 * порчи. Транспорт живёт в `LspConnection` (2.39), поэтому тест гоняет его.
 */
function connection(): LspConnection & { received: Record<string, unknown>[] } {
  const conn = new LspConnection("typescript", "/repo", { command: "fake", args: [] });
  const received: Record<string, unknown>[] = [];
  // перехватываем разбор на уровне сообщений, как делал прежний тест клиента
  (conn as unknown as { handleMessage: (m: Record<string, unknown>) => void }).handleMessage = (
    m,
  ) => {
    received.push(m);
  };
  return Object.assign(conn, { received });
}

describe("LspConnection framing (byte-accurate)", () => {
  it("parses frames whose body contains multi-byte UTF-8 split across chunks", () => {
    const conn = connection();
    const diag = {
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///a.ts",
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            message: "Тип 'string' не присваивается типу 'number'. Привет, мир!",
            severity: 1,
          },
        ],
      },
    };
    const body = Buffer.from(JSON.stringify(diag), "utf8");
    const frame = Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
      body,
    ]);

    // Разрезаем ВНУТРИ многобайтного символа — доказательство байтового фрейминга.
    const cut = Buffer.from("Ти", "utf8").length - 1;
    (conn as unknown as { handleData: (b: Buffer) => void }).handleData(frame.subarray(0, cut));
    (conn as unknown as { handleData: (b: Buffer) => void }).handleData(frame.subarray(cut));

    expect(conn.received).toHaveLength(1);
    const params = (conn.received[0] as { params: { diagnostics: Array<{ message: string }> } })
      .params;
    expect(params.diagnostics[0].message).toBe(
      "Тип 'string' не присваивается типу 'number'. Привет, мир!",
    );
  });

  it("parses two consecutive Cyrillic frames fed in one chunk", () => {
    const conn = connection();
    const mkFrame = (id: number): Buffer => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: "результат" }), "utf8");
      return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]);
    };
    (conn as unknown as { handleData: (b: Buffer) => void }).handleData(
      Buffer.concat([mkFrame(1), mkFrame(2)]),
    );

    expect(conn.received.map((m) => m.id)).toEqual([1, 2]);
    expect(conn.received[1].result).toBe("результат");
  });
});
