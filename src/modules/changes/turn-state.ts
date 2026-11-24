import { readFileSync } from "node:fs";
import { isMissingFile } from "./journal";

export type TurnStateRead =
  | { status: "missing" }
  | { status: "valid"; turn: number };

export class InvalidTurnStateError extends Error {
  constructor(file: string, cause: unknown) {
    super(`Invalid or corrupt turn state in ${file}`, { cause });
    this.name = "InvalidTurnStateError";
  }
}

export function readTurnState(
  file: string,
  decode: (content: string) => string,
): TurnStateRead {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { status: "missing" };
    throw new Error(`Unable to read turn state ${file}`, { cause: error });
  }
  try {
    const value: unknown = JSON.parse(decode(raw));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Turn state must be an object");
    }
    const state = value as Record<string, unknown>;
    if (
      state.v !== 1 ||
      typeof state.turn !== "number" ||
      !Number.isSafeInteger(state.turn) ||
      state.turn < 0
    ) {
      throw new Error("Turn state requires v:1 and a safe non-negative turn");
    }
    return { status: "valid", turn: state.turn };
  } catch (error) {
    throw new InvalidTurnStateError(file, error);
  }
}
