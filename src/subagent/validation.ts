/** Набор валидных инструментов (единый источник истины) */
export const VALID_TOOLS = new Set([
  "bash",
  "plan",
  "todo",
  "question",
  "approve",
  "theme",
  "user_profile",
  "subagent",
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "create_dir",
  "delete_file",
  "copy_file",
  "move_file",
  "file_info",
  "glob_search",
  "grep_search",
  "tree",
  "web_search",
  "web_fetch",
  "web_browse",
  "scaffold",
  "project_map",
]);

/** Обязательные аргументы для каждого инструмента */
export const REQUIRED_ARGS: Record<string, string[]> = {
  read_file: ["path"],
  write_file: ["path", "content"],
  edit_file: ["path", "old_string", "new_string"],
  list_dir: [],
  create_dir: ["path"],
  delete_file: ["path"],
  copy_file: ["source", "destination"],
  move_file: ["source", "destination"],
  file_info: ["path"],
  glob_search: ["pattern"],
  grep_search: ["pattern"],
  tree: [],
  web_search: ["query"],
  web_fetch: ["url"],
  user_profile: [],
  question: ["question"],
};

/**
 * Валидация tool call: проверка имени инструмента и обязательных аргументов.
 *
 * @param parsed - распарсенный JSON из tool call
 * @returns Результат валидации с именем инструмента и командой (для bash)
 */
export function validateToolCall(parsed: any): {
  valid: boolean;
  name?: string;
  cmd?: string;
  error?: string;
} {
  if (!parsed || typeof parsed !== "object") {
    return { valid: false, error: "Not an object" };
  }

  if (!parsed.name || !VALID_TOOLS.has(parsed.name)) {
    return { valid: false, error: `Unknown tool: ${parsed.name}` };
  }
  if (!parsed.arguments || typeof parsed.arguments !== "object") {
    return { valid: false, error: "Missing arguments" };
  }

  if (parsed.name === "bash") {
    const cmd = String(parsed.arguments.cmd ?? "").trim();
    if (!cmd) return { valid: false, error: "Empty command" };
    return { valid: true, name: parsed.name, cmd };
  }

  const required = REQUIRED_ARGS[parsed.name] ?? [];
  const missing = required.filter((k) => {
    const v = parsed.arguments[k];
    return v === undefined || v === null || v === "";
  });

  if (missing.length > 0) {
    return {
      valid: false,
      error: `Missing required argument(s): ${missing.join(", ")}. Tool "${parsed.name}" requires: ${required.join(", ")}`,
    };
  }

  return { valid: true, name: parsed.name };
}
