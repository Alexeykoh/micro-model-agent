import * as fs from "fs";
import { join } from "path";
import { homedir } from "os";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";

function searchFile(filePath: string, query: string, maxResults: number, results: string[]): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n").filter(Boolean)) {
    if (line.toLowerCase().includes(query)) {
      try {
        const entry = JSON.parse(line);
        results.push(`[${filePath}] ${JSON.stringify(entry).slice(0, 200)}`);
      } catch {
        /* skip */
      }
    }
    if (results.length >= maxResults) break;
  }
}

export const searchHistoryTool: ToolDefinition = {
  name: "search_history",
  description: "Search through session history for past interactions across all sessions.",
  tags: ["research"],
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      maxResults: {
        type: "number",
        description: "Maximum results (default 5)",
      },
      sessionId: {
        type: "string",
        description: "Optional: limit search to a specific session",
      },
    },
    required: ["query"],
  },
  handler: async (_ctx, args) => {
    const query = String(args.query || "").toLowerCase();
    const maxResults = Number(args.maxResults) || 5;
    const sessionId = args.sessionId ? String(args.sessionId) : null;
    const sessionDir = join(homedir(), ".mma", "sessions");
    const results: string[] = [];

    try {
      if (!fs.existsSync(sessionDir)) {
        return {
          success: true,
          output: t("tool.no_sessions_dir", { dir: sessionDir }),
        };
      }

      const entries = fs.readdirSync(sessionDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (sessionId && entry.name !== sessionId) continue;

        const historyFile = join(sessionDir, entry.name, "history.jsonl");
        searchFile(historyFile, query, maxResults, results);
        if (results.length >= maxResults) break;
      }

      if (results.length === 0) {
        return { success: true, output: t("tool.no_history", { query }) };
      }
      return {
        success: true,
        output: t("tool.history_results", {
          query,
          results: results.join("\n"),
        }),
      };
    } catch (err) {
      return {
        success: false,
        output: t("tool.history_error", { error: String(err) }),
      };
    }
  },
};
