/**
 * Durable interrupt (P1 HITL): пауза хода переживает рестарт процесса.
 * Файл `<sessionDir>/interrupt.json` (`{paused, pausedAt}`) ставится
 * `Agent.pause()` и снимается `Agent.resume()`; при старте хода
 * `executeAgentLoop` восстанавливает паузу до цикла.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";

export interface InterruptState {
  paused: boolean;
  pausedAt?: string;
}

const FILENAME = "interrupt.json";

export function saveInterruptFile(sessionDir: string, state: InterruptState): void {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const tmp = `${join(sessionDir, FILENAME)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, join(sessionDir, FILENAME));
}

export function loadInterruptFile(sessionDir: string): InterruptState | null {
  const path = join(sessionDir, FILENAME);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<InterruptState>;
    return typeof parsed.paused === "boolean" ? { paused: parsed.paused, pausedAt: parsed.pausedAt } : null;
  } catch {
    return null;
  }
}
