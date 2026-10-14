/** Тул скана корпуса: вопрос по МНОГИМ файлам, MAP каждого моделью + синтез. */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { t } from "../i18n/index";
import type { ToolContext, ToolDefinition, ToolResult } from "./types";
import { isPathInScope } from "../modules/security/path-validator";
import { matchProtectedPath } from "../modules/security/protected-paths";
import { scanCorpus } from "../core/context/scan-corpus";

/** Потолок числа файлов в одном скане — защита от гигантских каталогов. */
const MAX_FILES = 200;
/** Потолок глубины обхода — защита от патологических вложенных деревьев. */
const MAX_DEPTH = 20;
/** Пределы max_fanout: NaN/0/отрицательное/огромное не должны ломать движок. */
const MIN_FANOUT = 1;
const MAX_FANOUT_CAP = 32;
/** Каталоги, которые скан никогда не обходит. */
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".mma"]);

/** Итог сбора: файлы + флаг усечения по потолку. */
interface Collected {
  files: string[];
  truncated: boolean;
}

/**
 * Файл допустим для чтения моделью: в скоупе (INV-10, read-семантика) и не
 * защищённый (секреты/env/ключи). Дочерние файлы обходятся хендлером, поэтому
 * применяем то же правило, что исполнитель для корневого `path`.
 */
function isAllowedFile(ctx: ToolContext, filePath: string): boolean {
  const pathsCfg = ctx.config?.security?.paths;
  if (!isPathInScope(ctx.baseDir, filePath, ctx.scope, pathsCfg).allowed) return false;
  if (matchProtectedPath(ctx.baseDir, filePath)) return false;
  return true;
}

/**
 * Собирает обычные файлы под каталогом детерминированно.
 * Симлинки не разворачиваются (защита от циклов), глубина и число файлов
 * ограничены, защищённые каталоги пропускаются.
 */
function collectFiles(ctx: ToolContext, root: string): Collected {
  const files: string[] = [];
  let truncated = false;

  const walk = (p: string, depth: number): void => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    // Не следуем по симлинкам/junction — цикл дал бы бесконечный обход.
    if (st.isSymbolicLink()) return;
    if (st.isFile()) {
      if (isAllowedFile(ctx, p)) files.push(p);
      return;
    }
    if (!st.isDirectory()) return;
    if (depth >= MAX_DEPTH) return;
    // Защищённые каталоги (.git/.hg/.svn/…) не обходим.
    if (matchProtectedPath(ctx.baseDir, p)) return;

    let entries: string[];
    try {
      entries = readdirSync(p).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIPPED_DIRS.has(name)) continue;
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      walk(join(p, name), depth + 1);
    }
  };

  walk(root, 0);
  return { files, truncated };
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
        description: "Max concurrent files scanned at once (default 8, max 32).",
      },
    },
    required: ["question", "path"],
  },
  handler: async (ctx: ToolContext, args): Promise<ToolResult> => {
    const question = String(args.question || "");
    const path = String(args.path || "");

    if (!question) return { success: false, output: t("tool.scan_corpus_no_question") };
    if (!path) return { success: false, output: t("tool.scan_corpus_no_path") };

    if (!ctx.llmProvider) {
      return { success: false, output: t("tool.scan_corpus_no_provider") };
    }

    // Корневой `path` проверяет ToolExecutor по объявленному pathArgs (INV-10,
    // единая точка enforcement). Здесь валидируем только потомков.
    const resolved = resolve(ctx.baseDir, path);
    let collected: Collected;
    try {
      collected = lstatSync(resolved).isDirectory()
        ? collectFiles(ctx, resolved)
        : { files: isAllowedFile(ctx, resolved) ? [resolved] : [], truncated: false };
    } catch {
      collected = { files: [], truncated: false };
    }

    if (collected.files.length === 0) {
      return { success: false, output: t("tool.scan_corpus_no_files") };
    }

    const rawFanout = args.max_fanout;
    const maxFanout =
      typeof rawFanout === "number" && Number.isFinite(rawFanout)
        ? Math.min(MAX_FANOUT_CAP, Math.max(MIN_FANOUT, Math.floor(rawFanout)))
        : undefined;

    const res = await scanCorpus(ctx.llmProvider, {
      question,
      files: collected.files,
      readFile: (p) => readFileSync(p, "utf8"),
      maxFanout,
      logger: ctx.logger,
      sessionId: ctx.sessionId,
    });

    const synthesis =
      res.synthesis || res.findings.map((f) => `${f.path}: ${f.answer}`).join("\n");
    const body = t("tool.scan_corpus_result", { files: String(res.scanned), synthesis });
    const output = collected.truncated
      ? `${body}\n\n${t("tool.scan_corpus_truncated", { limit: String(MAX_FILES) })}`
      : body;
    return { success: true, output };
  },
};
