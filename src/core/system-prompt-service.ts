/**
 * Короткий системный промпт service-job (S-04, B20).
 *
 * Вынесено из `system-prompt.ts` (правило ≤300 строк). Говорит модели ровно
 * то, что она должна знать: кто она, на какой модели работает, какие тулы
 * реально доступны (или что их нет), что нельзя выдумывать работу — плюс
 * компактные security-ограничения, когда в job есть тулы.
 */
import type { AppConfig } from "../config/types";

/**
 * Собирает короткий системный промпт service-job.
 * @param model активная модель (живой конфиг);
 * @param tools имена тулов, видимых модели в этой задаче;
 * @param security правила безопасности (показываем, только если есть тулы).
 */
export function buildServiceJobPrompt(
  model: string,
  tools: readonly string[],
  security?: AppConfig["security"],
): string {
  const toolLine = tools.length
    ? `Available tools: ${tools.join(", ")}. Use them only when the task needs them.`
    : "No tools are available in this job: you cannot read files, run commands or browse the web.";
  const lines = [
    `You are MMA answering one service job. Active model: ${model}.`,
    "Answer the request directly and completely, in the user's language.",
    toolLine,
    "Do not claim work you did not do: no invented file contents, command output or web pages.",
    "If the task needs something unavailable, say so plainly instead of guessing.",
  ];
  // B20: job с тулами обязан знать про блокировки — иначе жжёт платные вызовы,
  // которые full-режим отсёк бы заранее. Компактно: lean-бюджет < 300 токенов.
  if (security?.enabled && tools.length > 0) {
    lines.push(
      `SECURITY RESTRICTIONS (enforced — blocked calls return "[SECURITY BLOCKED]", do not retry them).`,
    );
  }
  return lines.join("\n");
}
