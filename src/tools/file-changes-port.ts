/** Контракт журнала правок файлов (модуль `changes`) для `ToolContext`. */
import type {
  ChangeEntry,
  ListOptions,
  UndoOptions,
  UndoResult,
} from "../modules/changes/types";
import type { ToolCall, ToolContext, ToolDefinition } from "./types";

/** Снапшоты правок вокруг вызова тула и откат по сессии. */
export interface FileChangesPort {
  beginTurn(sessionId: string): void;
  captureBefore(ctx: ToolContext, tool: ToolDefinition, call: ToolCall): void;
  captureAfter(callId: string, success: boolean): void;
  cancel(callId: string): void;
  clear(): void;
  list(options: ListOptions): ChangeEntry[];
  undo(options: UndoOptions): UndoResult;
}
