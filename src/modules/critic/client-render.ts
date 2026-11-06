// Сборка evidence-пакета в текст для критика (без сетевого клиента).
import type { EvidencePack } from "./types";

/** Строка веб-обоснования для пакета критика (attempted/verified + unverified claims). */
export function renderWebGrounding(g: EvidencePack["webGrounding"]): string {
  if (!g) return "WEB GROUNDING: (none)";
  const claims = g.unverifiedClaims ? `, unverifiedClaims=[${g.unverifiedClaims.join(", ")}]` : "";
  return `WEB GROUNDING: attempted=${g.attempted}, verified=${g.verified}${claims}`;
}

/** Единый текст пакета, который видит критик. */
export function renderPack(pack: EvidencePack): string {
  const cmdLines = pack.commands.map((c) => {
    const base = `${c.command} (exit ${c.exitCode ?? "?"})`;
    return c.output ? `${base}\n  output: ${c.output}` : base;
  });
  const files = (pack.fileExcerpts ?? []).map((f) => `--- ${f.path} ---\n${f.excerpt}`);
  return [
    `TASK: ${pack.task}`,
    pack.planSummary ? `PLAN: ${pack.planSummary}` : "",
    `CHANGED FILES: ${pack.changedFiles.join(", ") || "(none)"}`,
    `COMMANDS: ${cmdLines.join("; ") || "(none)"}`,
    renderWebGrounding(pack.webGrounding),
    "TOOL TRAIL:",
    pack.toolDigest || "(empty)",
    files.length > 0 ? `FILE CONTENTS:\n${files.join("\n")}` : "",
    pack.answerExcerpt
      ? `ANSWER (the agent's chat delivery — may satisfy the task without files):\n${pack.answerExcerpt}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Текст ошибки/исключения одной строкой. */
export function describe(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

/** Обрезка для диагностики — логи не должны расти от сырого ответа модели. */
export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
