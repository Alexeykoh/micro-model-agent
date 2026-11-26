/**
 * Декларативные альтернативы на коды отказа bash-валидатора: один раз
 * оформить, что делать вместо заблокированной формы команды.
 *
 * Ключ — структурированная причина, которую возвращает `isCommandAllowed()`,
 * а не текст пользовательского запроса (правило №10 архитектуры).
 */
import { t } from "../../i18n/index";

export type BlockReasonKind =
  | "operator"
  | "chaining"
  | "interpreter"
  | "multiline"
  | "blacklist"
  | "whitelist"
  | "dangerousFlag"
  | "shellWrapper"
  | "unknown";

/** Таблица соответствия причины и вида альтернативы (декларативные данные). */
const REASON_KINDS: Array<{ kind: BlockReasonKind; match: (reason: string) => boolean }> = [
  { kind: "operator", match: (r) => r.startsWith("Operator ") },
  { kind: "chaining", match: (r) => r.startsWith("Command chaining") },
  { kind: "interpreter", match: (r) => r.startsWith("Interpreter ") },
  { kind: "multiline", match: (r) => r.startsWith("Multi-line commands") },
  { kind: "blacklist", match: (r) => r.includes(" is blacklisted") },
  { kind: "whitelist", match: (r) => r.includes(" is not in the whitelist") },
  { kind: "dangerousFlag", match: (r) => r.startsWith("Dangerous flag ") },
  { kind: "shellWrapper", match: (r) => r.startsWith("Shell wrapper") },
];

/** Команды, для которых известен самостоятельный тул с тем же результатом. */
const HTTP_COMMANDS = new Set(["curl", "wget"]);

export function blockReasonKind(reason: string): BlockReasonKind {
  return REASON_KINDS.find((entry) => entry.match(reason))?.kind ?? "unknown";
}

function quotedCommand(reason: string): string {
  return reason.match(/"([^"]+)"/)?.[1]?.toLowerCase() ?? "";
}

/** actionable-замена или пустая строка, если универсального совета нет. */
export function blockAlternativeHint(reason: string): string {
  const kind = blockReasonKind(reason);
  if (kind === "blacklist" && HTTP_COMMANDS.has(quotedCommand(reason))) {
    return t("bash.alt_http");
  }
  switch (kind) {
    case "operator":
      return t("bash.alt_operator");
    case "chaining":
      return t("bash.alt_chaining");
    case "interpreter":
      return t("bash.alt_interpreter");
    case "multiline":
      return t("bash.alt_multiline");
    case "blacklist":
      return t("bash.alt_blacklist");
    case "dangerousFlag":
      return t("bash.alt_dangerous_flag");
    case "shellWrapper":
      return t("bash.alt_shell_wrapper");
    case "whitelist":
      return t("bash.alt_whitelist");
    default:
      return "";
  }
}
