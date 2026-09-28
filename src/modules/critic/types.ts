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
