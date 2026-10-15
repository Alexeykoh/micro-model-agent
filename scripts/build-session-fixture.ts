// Скрипт сборки обезличенной фикстуры для tests/fixtures из реальной сессии.
// Запуск: bun scripts/build-session-fixture.ts <sessionId> <outPath>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const [sessionId, outPath] = process.argv.slice(2);
if (!sessionId || !outPath) {
  // Скрипт запускается из CLI, вне OutputBus: писать в stderr напрямую.
  process.stderr.write("usage: bun scripts/build-session-fixture.ts <sessionId> <outPath>\n");
  process.exit(1);
}

const src = join(homedir(), ".mma", "sessions", sessionId, "session.jsonl");
const entries = readFileSync(src, "utf-8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>);

/** Поля, которые несут патологию — сохраняем. Всё остальное содержит личные данные. */
const KEEP = new Set([
  "type", "ts", "iteration", "tool", "success", "reason", "strategy", "kind",
  "operation", "errorKind", "tokensBefore", "tokensAfter", "messagesBefore",
  "messagesAfter", "systemTokens", "systemBudget", "window", "quality",
  "messageCount", "compactionCount", "promptTokens", "completionTokens",
  "cachedTokens", "totalTokens", "blocks", "content", "model", "provider",
]);

/**
 * `content` несёт сигнатуру только в `tool_result` (текст `SECURITY BLOCKED` и
 * ошибок) и в диагностических событиях. В `assistant`/`reasoning`/`tool_call`
 * это содержимое работы модели — проекта и пользователя, оно в фикстуре не нужно.
 */
const KEEP_CONTENT = new Set(["tool_result", "audit", "critic_error", "claim_retry", "context_degraded"]);
const SECRET_TEXT = [
  /E:\\projects\\[^\s"']+/gi,
  /[A-Za-z]:\\[^\s"',]+/g,
  /ses_[a-z0-9_]+/g,
  /sk-[A-Za-z0-9_-]+/g,
  /qwen\/[A-Za-z0-9._-]+/g,
];

function scrubText(text: string): string {
  let out = text;
  for (const re of SECRET_TEXT) out = out.replace(re, "<redacted>");
  return out;
}

const scrubbed = entries.map((e) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (!KEEP.has(k)) continue;
    if (k === "content") {
      const type = String(e.type ?? "");
      // Диагностические события приносят cause/operation, а не свободный текст.
      const isDiagnostic = type.endsWith("_error") || type.endsWith("_degraded");
      if (!KEEP_CONTENT.has(type) && !isDiagnostic) continue;
      // Успешный tool_result — это дамп файла/вывода: проекта и пользователя.
      // Сигнатуру несёт только провал, и достаточно его начала.
      if (type === "tool_result" && e.success !== false) continue;
    }
    out[k] = typeof v === "string" ? scrubText(v).slice(0, 300) : v;
  }
  return out;
});

const body = `${scrubbed.map((e) => JSON.stringify(e)).join("\n")}\n`;
mkdirSync(join(outPath, ".."), { recursive: true });
writeFileSync(outPath, body, "utf-8");
process.stdout.write(`${entries.length} entries -> ${outPath}\n`);