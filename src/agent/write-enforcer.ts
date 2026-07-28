import type { ParsedCall } from "../tools/parse-tool-call.js";
import type { ChatMessage } from "../llm/provider.js";
import type { OutputRenderer } from "../ui/renderer.js";

export class WriteEnforcer {
  enforceSingleWrite(
    _validCalls: ParsedCall[],
    _messages: ChatMessage[],
    _quiet?: boolean,
    _renderer?: OutputRenderer,
  ): void {
    // Больше не блокируем множественные записи.
    // Синтаксическая проверка работает per-file,
    // а write-трекинг ведётся через createdFiles.
  }
}
