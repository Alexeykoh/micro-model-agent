import { describe, expect, it } from "vitest";
import {
  assembledToolCalls,
  parseStreamLine,
  type ToolCallAcc,
} from "../../src/llm/openai-sse";
import { StreamState } from "../../src/llm/stream-state";

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}`;
}

function collect(lines: string[], accs: Map<number, ToolCallAcc>) {
  const st = new StreamState();
  const chunks = [];
  for (const line of lines) {
    for (const chunk of parseStreamLine(line, st, accs, "auto", null)) chunks.push(chunk);
  }
  return { st, chunks };
}

describe("openai-compat: расщеплённые токены в стриме", () => {
  it("текст, пришедший частями, отдаётся по частям без hold-back", () => {
    const { chunks } = collect(
      [
        frame({ choices: [{ delta: { content: "Привет " } }] }),
        frame({ choices: [{ delta: { content: "мир" } }] }),
      ],
      new Map(),
    );
    expect(chunks.map((c) => (c.type === "text" ? c.content : null))).toEqual(["Привет ", "мир"]);
  });

  it("аргументы tool_call, расщеплённые на несколько дельт, собираются в один валидный вызов", () => {
    const accs = new Map<number, ToolCallAcc>();
    const { chunks } = collect(
      [
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"pa' } },
                ],
              },
            },
          ],
        }),
        frame({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }],
              },
            },
          ],
        }),
        frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      ],
      accs,
    );

    const calls = chunks.filter((c) => c.type === "tool_call");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call.type !== "tool_call" || !call.toolCall) throw new Error("no tool call");
    expect(call.toolCall.id).toBe("call_1");
    expect(call.toolCall.name).toBe("read_file");
    expect(JSON.parse(call.toolCall.arguments)).toEqual({ path: "a.txt" });
    // Повторный проход по тем же аккумуляторам после финала не дублирует вызов.
    expect(assembledToolCalls(accs)).toEqual([]);
  });
});
