// Admission результата тула (OO-1): крупный вывод не входит в контекст
// дословно — спилл в .mma/context/<session>/ + дескриптор с превью и путём.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { estimateTokens } from "../llm/token-counter";
import { t } from "../i18n/index";
import type { ToolResult } from "./types";

/** Сколько первых строк вывода оставить в превью дескриптора. */
const PREVIEW_LINES = 12;
/** Каталог спилла относительно baseDir. */
const DEFAULT_SPILL_DIR = ".mma/context";

export interface AdmitOptions {
  baseDir: string;
  sessionId: string;
  maxTokens: number;
  source?: string;
  spillDir?: string;
}

/**
 * Пропускает результат как есть, если он мал или неуспешен. Иначе спилит вывод
 * в файл и подменяет его компактным дескриптором (превью + путь артефакта).
 * @param result результат тула; @param opts параметры admission.
 * @returns исходный либо урезанный до дескриптора результат.
 */
export function admitToolResult(result: ToolResult, opts: AdmitOptions): ToolResult {
  const output = result.output ?? "";
  if (!result.success || !output) return result;
  const tokens = estimateTokens(output);
  if (tokens <= opts.maxTokens) return result;

  const dir = resolve(opts.baseDir, opts.spillDir ?? DEFAULT_SPILL_DIR, opts.sessionId);
  mkdirSync(dir, { recursive: true });
  const artifact = join(dir, `${Date.now().toString(36)}.txt`);
  writeFileSync(artifact, output, "utf8");

  const lines = output.split("\n").length;
  const preview = output.split("\n").slice(0, PREVIEW_LINES).join("\n");
  const descriptor = t("tool.output_admitted", {
    tokens: String(tokens),
    lines: String(lines),
    artifact,
    source: opts.source ?? "-",
    preview,
  });
  return { ...result, output: descriptor, artifactPath: artifact };
}
