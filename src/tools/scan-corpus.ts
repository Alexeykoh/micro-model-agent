/** Тул скана корпуса: вопрос по МНОГИМ файлам, MAP каждого моделью + синтез. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { t } from "../i18n/index";
import type { ToolDefinition, ToolContext, ToolResult } from "./types";
import { isPathInScope } from "../modules/security/path-validator";
import { scanCorpus } from "../core/context/scan-corpus";

/** Потолок числа файлов в одном скане — защита от гигантских каталогов. */
const MAX_FILES = 200;
/** Каталоги, которые скан никогда не обходит. */
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".mma"]);

/** Рекурсивно собирает обычные файлы под каталогом (детерминированно). */
function collectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    if (out.length >= MAX_FILES) return;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isFile()) {
      out.push(p);
      return;
    }
    if (!st.isDirectory()) return;
    let entries: string[];
    try {
      entries = readdirSync(p).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIPPED_DIRS.has(name)) continue;
      walk(join(p, name));
      if (out.length >= MAX_FILES) return;
    }
  };
  walk(root);
  return out;
}

/** Отвечает на вопрос по многим файлам: скан каждого моделью + синтез. */
export const scanCorpusTool: ToolDefinition = {
  name: "scan_corpus",
  security: { caps: [{ fs: "read" }], pathArgs: ["path"] },
  icon: "🔎",
  description:
    "Answer a question over MANY files under a path (file or directory) by scanning each file with the model and synthesizing the findings into one answer, with bounded fanout and hierarchical partitioning. Use when the corpus is too large to read directly or to fit in the context window.",
  tags: ["research"],
  /** Несколько LLM-вызовов на файл плюс синтез — нужен больший бюджет. */
  timeoutMs: 300000,
  boundedOutput: true,
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to answer over the corpus.",
      },
      path: {
        type: "string",
        description: "File or directory to scan (scope-checked).",
      },
      max_fanout: {
        type: "number",
        description: "Max concurrent files scanned at once (default 8).",
      },
    },
    required: ["question", "path"],
  },
  handler: async (ctx: ToolContext, args): Promise<ToolResult> => {
    const question = String(args.question || "");
    const path = String(args.path || "");

    if (!question) return { success: false, output: t("tool.scan_corpus_no_question") };
    if (!path) return { success: false, output: t("tool.scan_corpus_no_question") };

    if (!ctx.llmProvider) {
      return { success: false, output: t("tool.scan_corpus_no_provider") };
    }

    // Политику пути дополнительно применяет ToolExecutor (INV-10), но скан
    // обходит файлы сам, поэтому скоуп проверяем и здесь.
    const check = isPathInScope(ctx.baseDir, path, ctx.scope);
    if (!check.allowed) {
      return { success: false, output: `[SCOPE] ${check.reason ?? "Path not allowed"}` };
    }

    const resolved = resolve(ctx.baseDir, path);
    let files: string[];
    try {
      files = statSync(resolved).isDirectory() ? collectFiles(resolved) : [resolved];
    } catch {
      files = [];
    }
    files = files.slice(0, MAX_FILES).sort();
    if (files.length === 0) {
      return { success: false, output: t("tool.scan_corpus_no_files") };
    }

    const res = await scanCorpus(ctx.llmProvider, {
      question,
      files,
      readFile: (p) => readFileSync(p, "utf8"),
      maxFanout: typeof args.max_fanout === "number" ? args.max_fanout : undefined,
      logger: ctx.logger,
      sessionId: ctx.sessionId,
    });

    const synthesis =
      res.synthesis || res.findings.map((f) => `${f.path}: ${f.answer}`).join("\n");
    return {
      success: true,
      output: t("tool.scan_corpus_result", { files: String(res.scanned), synthesis }),
    };
  },
};
