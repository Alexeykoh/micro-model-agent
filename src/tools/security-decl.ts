/** Декларация возможностей тула и аргументов политик (INV-9/10). */

/** Возможность тула, которую применяет `ToolExecutor.execute()` (INV-9/10). */
export type ToolCapability =
  | { fs: "read" }
  | { fs: "write" }
  | { fs: "any" }
  | { net: true }
  | { proc: true }
  | { interactive: true }
  | { mem: true }
  | { subagent: true };

/** Декларация политик тула: один источник правды вместо проверок в хендлере. */
export interface ToolSecurityDecl {
  /** Что тул умеет; `[]` — не делает ничего привилегированного. */
  caps: ToolCapability[];
  /** Аргументы-пути: enforcement применяет scope + protected-пути (INV-10). */
  pathArgs?: string[];
  /** Аргументы-URL: enforcement применяет SSRF-политику (INV-10). */
  urlArgs?: string[];
  /** Явная отказка от декларации (особые тулы; видно в `/tools`). */
  manual?: { reason: string; reviewedBy: string; date: string };
}
