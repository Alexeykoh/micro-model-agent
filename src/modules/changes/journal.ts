import { readFileSync } from "node:fs";
import { parseChangeEntry, type ChangeEntry } from "./types";

export type JournalRead =
  | { status: "missing" }
  | { status: "present"; lines: string[] };

export function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export function readChangeJournal(file: string): JournalRead {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { status: "missing" };
    throw new Error(`Unable to read change journal ${file}`, { cause: error });
  }
  if (raw.length === 0) return { status: "present", lines: [] };
  const lines = raw.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return { status: "present", lines };
}

export function parseJournalLines(
  lines: string[],
  strict: boolean,
  file = "change journal",
): ChangeEntry[] {
  if (!strict) {
    return lines.flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        const entry = parseChangeEntry(value);
        return entry ? [entry] : [];
      } catch {
        return [];
      }
    });
  }
  return lines.map((line, index) => {
    if (line.length === 0) {
      throw new Error(`Corrupt change journal ${file}: empty line ${index + 1}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Corrupt change journal ${file}: invalid JSON on line ${index + 1}`, {
        cause: error,
      });
    }
    const entry = parseChangeEntry(value);
    if (!entry) {
      throw new Error(`Corrupt change journal ${file}: invalid entry on line ${index + 1}`);
    }
    return entry;
  });
}
