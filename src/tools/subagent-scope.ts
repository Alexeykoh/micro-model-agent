// Скоуп субагента при спавне: нормализация записей и отказ на невалидных.
//
// Контракт записи (спека `2026-11-02-subagent-scope-entries-design` §A):
// путь / glob (`src/**/*.ts`) / абсолютная запись / `**` = весь workspace.
// Невалидные записи не отбрасываются молча: пустой скоуп = «нет доступа ко
// всему», и причина отказа осталась бы необъяснимой (INV-S2: нормализация —
// здесь, до `setScope`; матчер валидатора записей не парсит).
import { t } from "../i18n/index";
import { normalizeScopeEntries } from "../modules/security/scope";
import type { ToolScope } from "./types";

/** Итог подготовки скоупа: либо нормализованный скоуп, либо причина отказа. */
export interface PreparedScope {
  scope?: ToolScope;
  error?: string;
}

/** Аргументы спавна → запрошенный скоуп (явный список или унаследованный). */
function scopeFromArgs(
  args: Record<string, unknown>,
  inherited?: ToolScope,
): ToolScope | undefined {
  if (!args.allowed_files && !args.read_only_files) return inherited;
  return {
    allowed_files: (args.allowed_files as string[]) || [],
    read_only_files: (args.read_only_files as string[]) || [],
  };
}

/** Проверить и нормализовать скоуп субагента перед прогоном. */
export function prepareScope(args: Record<string, unknown>, inherited?: ToolScope): PreparedScope {
  const input = scopeFromArgs(args, inherited);
  if (!input) return {};
  const allowed = normalizeScopeEntries(input.allowed_files);
  const readOnly = normalizeScopeEntries(input.read_only_files);
  const invalid = [...allowed.invalid, ...readOnly.invalid];
  if (invalid.length > 0) {
    return {
      error: t("tool.subagent_scope_invalid", {
        entries: invalid.map((bad) => `${bad.raw} (${bad.reason})`).join("; "),
      }),
    };
  }
  return { scope: { allowed_files: allowed.entries, read_only_files: readOnly.entries } };
}
