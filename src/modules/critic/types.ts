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
  commands: Array<{ command: string; exitCode?: number }>;
  toolDigest: string;
}

/** UI-facing summary of a non-ok critic verdict (terminal + web feed). */
export interface CriticUiEvent {
  status: "concern" | "critical";
  issueCount: number;
  summary: string;
  /** True when the verdict triggered a bounded repair cycle. */
  repair: boolean;
}
