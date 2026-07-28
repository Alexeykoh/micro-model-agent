import { generateToolCallId } from "../tools/id-gen.js";
import type { ParsedCall } from "../tools/parse-tool-call.js";
import type { ChatMessage } from "../llm/provider.js";
import type { OutputRenderer } from "../ui/renderer.js";

export class WriteEnforcer {
  enforceSingleWrite(
    validCalls: ParsedCall[],
    messages: ChatMessage[],
    quiet?: boolean,
    renderer?: OutputRenderer,
  ): void {
    const writeCalls = validCalls.filter(
      (c) => c.parsed.name === "write_file" || c.parsed.name === "edit_file",
    );
    if (writeCalls.length <= 1) return;

    const blocked = writeCalls.slice(1);
    const firstBlocked = blocked[0];
    const startIdx = validCalls.indexOf(firstBlocked);
    if (startIdx !== -1) {
      validCalls.splice(startIdx, blocked.length);
    }
    for (const bc of blocked) {
      const blockId = generateToolCallId();
      messages.push({
        role: "tool",
        content:
          "BLOCKED: Only one file write per response is allowed. You wrote " +
          writeCalls.length +
          " files at once. Complete the first file, then write the next one.",
        tool_call_id: blockId,
      });
    }
    if (!quiet) {
      renderer?.writeWarning(
        "  [blocked " + blocked.length + " extra file writes — one at a time]",
      );
    }
  }
}
