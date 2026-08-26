import { describe, it, expect } from "vitest";
import { LspClient } from "../src/modules/lsp/client";

describe("LspClient LSP framing (byte-accurate)", () => {
  it("parses frames whose body contains multi-byte UTF-8 split across chunks", () => {
    const client = new LspClient();
    const messages: Record<string, unknown>[] = [];
    (client as any).handleMessage = (msg: Record<string, unknown>) => {
      messages.push(msg);
    };

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

    // Split INSIDE a multi-byte character to prove byte-level framing.
    const cut = Buffer.from("Ти", "utf8").length - 1;
    (client as any).handleData(frame.subarray(0, cut));
    (client as any).handleData(frame.subarray(cut));

    expect(messages).toHaveLength(1);
    const params = (messages[0] as any).params;
    expect(params.diagnostics[0].message).toBe(
      "Тип 'string' не присваивается типу 'number'. Привет, мир!",
    );
  });

  it("parses two consecutive Cyrillic frames fed in one chunk", () => {
    const client = new LspClient();
    const messages: Record<string, unknown>[] = [];
    (client as any).handleMessage = (msg: Record<string, unknown>) => {
      messages.push(msg);
    };

    const mkFrame = (id: number): Buffer => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: "результат" }), "utf8");
      return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]);
    };
    (client as any).handleData(Buffer.concat([mkFrame(1), mkFrame(2)]));

    expect(messages.map((m) => (m as any).id)).toEqual([1, 2]);
    expect(messages[1].result).toBe("результат");
  });
});
