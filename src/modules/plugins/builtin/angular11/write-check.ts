// Проверка идиом Angular 11 после записи файла (F3 плагина `angular11`).
//
// Срабатывает только на write_file/edit_file внутри Angular-воркспейса и только
// для `.ts`/`.html`. Ничего не запускает (без процессов) — дешёвые regex-правила
// из `rules.ts`. Находки дописываются в `result.output`, как у `lint-on-write`.
import { existsSync, readFileSync } from "fs";
import { extname, resolve } from "path";
import type { ToolCall, ToolResult } from "../../../../tools/types";
import { isAngularProject } from "./detect";
import { checkContent } from "./rules";

/** Хук после тула: дописать находки в вывод, если файл — рабочий файл Angular. */
export function runWriteCheck(ctx: { baseDir: string }, call: ToolCall, result: ToolResult): void {
  if (call.name !== "write_file" && call.name !== "edit_file") return;
  if (!result.success) return;

  const path = String(call.arguments?.path ?? "");
  if (!path) return;

  const ext = extname(path);
  if (ext !== ".ts" && ext !== ".html") return;

  if (!isAngularProject(ctx.baseDir)) return;

  const full = resolve(ctx.baseDir, path);
  if (!existsSync(full)) return;

  let content: string;
  try {
    content = readFileSync(full, "utf-8");
  } catch {
    return;
  }

  const findings = checkContent(ext, content);
  if (findings.length === 0) return;

  const lines = findings.map((f) => `- [${f.severity}] ${f.message}`);
  result.output += `\n\n[Angular 11 check]:\n${lines.join("\n")}`;
}
