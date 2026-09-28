export type CriticSeverity = "info" | "concern" | "critical";

export interface CriticIssue {
  severity: CriticSeverity;
  claim: string;
  problem: string;
  suggestion?: string;
  evidence?: string;
}

export interface CriticVerdict {
  status: "ok" | "concern" | "critical";
  summary: string;
  issues: CriticIssue[];
  /**
   * Read-only verification checks requested by the critic (Phase 2). Parsed
   * leniently — allowlist + cap are enforced in `parseChecks`
   * (`src/modules/critic/tools.ts`), never trusted blindly.
   */
  checks?: Array<{ tool: string; args?: Record<string, unknown> }>;
}

export interface EvidencePack {
  task: string;
  planSummary?: string;
  changedFiles: string[];
  commands: Array<{ command: string; exitCode?: number; output?: string }>;
  toolDigest: string;
  /** Bounded head excerpts of changed files (read from disk when baseDir is known). Absent when unreadable. */
  fileExcerpts?: Array<{ path: string; excerpt: string }>;
}
