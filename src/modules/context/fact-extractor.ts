import type { Message } from "./manager";
import { getMessageText } from "../../llm/provider";

/**
 * Regex-based fact extraction from tool/assistant messages. Owns the file /
 * deleted / decision / error fact lists that survive compaction. Extracted
 * from ContextManager so the ~115-line regex logic has one home (rule #2).
 */
export class FactExtractor {
  private fileFacts: string[] = [];
  private deletedFacts: string[] = [];
  private decisionFacts: string[] = [];
  private errorFacts: string[] = [];
  private static readonly MAX_FACTS = 20;

  get errorCount(): number {
    return this.errorFacts.length;
  }

  /** Scan a batch of compacted turns and fold their facts into the lists. */
  extract(turns: Message[]): void {
    // Absolute Windows paths ("E:\proj\src\a.ts") need an optional drive prefix;
    // without it the colon breaks the match and the fact is silently dropped.
    const DRIVE = "(?:[a-zA-Z]:[\\\\/])?";
    const createdPatterns = [
      new RegExp(`(?:Created|Updated|Written|Moved|Replaced in) ${DRIVE}([\\w./\\\\-]+\\.[a-z]+)`, "gi"),
      new RegExp(`Файл (?:создан|обновлён|записан|перемещён):? ${DRIVE}([\\w./\\\\-]+\\.[a-z]+)`, "gi"),
      new RegExp(`file (?:created|updated|written|moved):? ${DRIVE}([\\w./\\\\-]+\\.[a-z]+)`, "gi"),
    ];
    const deletedPatterns = [
      new RegExp(`Deleted ${DRIVE}([\\w./\\\\-]+\\.[a-z]+)`, "gi"),
      new RegExp(`(?:Удалён|Файл удалён):? ${DRIVE}([\\w./\\\\-]+\\.[a-z]+)`, "gi"),
    ];

    const newFiles: string[] = [];
    const newDeleted: string[] = [];
    const newDecisions: string[] = [];
    const newErrors: string[] = [];
    // Track the LAST tool event per path so a delete followed by a re-create
    // (or vice versa) in the same window resolves to its final state instead of
    // being both filtered out of [Files:] and reported as [Deleted:].
    const lastEvent = new Map<string, "file" | "deleted">();

    for (const msg of turns) {
      const content = getMessageText(msg.content);

      // Never feed a previous <system-summary> block into new facts — that is
      // the source of recursive summary nesting (summary inside summary).
      if (
        msg.role === "user" &&
        (content.startsWith("<system-summary>") ||
          content.includes("[Compressed:"))
      ) {
        continue;
      }

      if (msg.role === "tool") {
        for (const pattern of createdPatterns) {
          for (const match of content.matchAll(pattern)) {
            newFiles.push(match[1]);
            lastEvent.set(match[1], "file");
          }
        }
        for (const pattern of deletedPatterns) {
          for (const match of content.matchAll(pattern)) {
            newDeleted.push(match[1]);
            lastEvent.set(match[1], "deleted");
          }
        }

        if (content.includes("Plan:") && content.includes("[")) {
          const planLine = content
            .split("\n")
            .find((line) => line.includes("Plan:"));
          if (planLine) newDecisions.push(planLine.trim());
        }
      }

      if (msg.role === "assistant") {
        if (content.includes("decided:") || content.includes("decision:")) {
          const line = content
            .split("\n")
            .find((l) => l.includes("decided:") || l.includes("decision:"));
          if (line) newDecisions.push(line.trim().slice(0, 200));
        }
      }

      if (
        content.includes("Error:") ||
        content.includes("failed") ||
        content.includes("Ошибка:") ||
        content.includes("не удалось")
      ) {
        const line = content
          .split("\n")
          .find(
            (l) =>
              l.includes("Error:") ||
              l.includes("failed") ||
              l.includes("Ошибка:") ||
              l.includes("не удалось"),
          );
        if (line) newErrors.push(line.trim().slice(0, 250));
      }
    }

    // Deduplicate and cap facts to prevent unbounded growth. Files that were
    // DELETED leave the "known files" list — a deleted file must not keep
    // being reported as existing (observed: deleted .js files listed in
    // every [Files: ...] block for the whole session). A path that is deleted
    // then RE-CREATED (delete_file A → write_file A) is un-deleted: the last
    // event in the window wins, so it returns to [Files:] and leaves [Deleted:].
    const dedup = (arr: string[]): string[] => [...new Set(arr)];
    const finalFiles = dedup(
      newFiles.filter((p) => lastEvent.get(p) === "file"),
    );
    const finalDeleted = dedup(
      newDeleted.filter((p) => lastEvent.get(p) === "deleted"),
    );
    this.fileFacts = dedup(
      [...this.fileFacts, ...finalFiles].filter(
        (p) => !finalDeleted.includes(p),
      ),
    ).slice(-FactExtractor.MAX_FACTS);
    this.deletedFacts = dedup(
      [...this.deletedFacts, ...finalDeleted].filter(
        (p) => !finalFiles.includes(p),
      ),
    ).slice(-FactExtractor.MAX_FACTS);
    this.decisionFacts = dedup([...this.decisionFacts, ...newDecisions]).slice(
      -FactExtractor.MAX_FACTS,
    );
    this.errorFacts = dedup([...this.errorFacts, ...newErrors]).slice(
      -FactExtractor.MAX_FACTS,
    );
  }

  /** `[Files: a; b]` line for a compaction summary, or null. */
  filesLine(): string | null {
    const deletedSet = new Set(this.deletedFacts);
    const liveFiles = this.fileFacts.filter((p) => !deletedSet.has(p));
    if (liveFiles.length === 0) return null;
    return `[Files: ${liveFiles.slice(-15).join("; ")}]`;
  }

  /** `[Deleted: c]` line, or null. */
  deletedLine(): string | null {
    if (this.deletedFacts.length === 0) return null;
    return `[Deleted: ${this.deletedFacts.slice(-10).join("; ")}]`;
  }

  /** `[Decisions: d]` line, or null. */
  decisionsLine(): string | null {
    if (this.decisionFacts.length === 0) return null;
    return `[Decisions: ${this.decisionFacts.slice(-5).join("; ")}]`;
  }
  /** `[Errors: e]` line, or null. */
  errorsLine(): string | null {
    if (this.errorFacts.length === 0) return null;
    return `[Errors: ${this.errorFacts.slice(-3).join("; ")}]`;
  }
}
