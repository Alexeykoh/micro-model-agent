export type ChangeOp = "write" | "delete" | "move" | "undo" | "evicted";

export interface ChangeEntry {
  v: 1;
  id: string;
  ts: string;
  turn: number;
  tool: string;
  callId: string;
  op: ChangeOp;
  path: string;
  pathAbs: string;
  before: string | null;
  after: string | null;
  bytes: number;
  mode?: number;
  to?: string;
  toBefore?: string | null;
  targetId?: string;
  skipped?: "too-large" | "evicted" | "unsupported";
}

export interface UndoItem {
  path: string;
  ok: boolean;
  reason?: string;
}

export interface UndoResult {
  ok: boolean;
  message: string;
  items: UndoItem[];
  diff?: string;
}

export interface ListOptions {
  sessionId: string;
  baseDir: string;
  path?: string;
  limit?: number;
}

export interface UndoOptions {
  sessionId: string;
  baseDir: string;
  path?: string;
  steps?: number;
  turn?: number;
  force?: boolean;
}
