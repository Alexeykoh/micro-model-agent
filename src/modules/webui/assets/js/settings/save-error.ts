// Коды причины из `POST /api/config` → текст для тоста.
// `/api/config` отвечает машинным кодом (`invalid-value`, `unknown-key`,
// `read-only`); показывать его сырым нельзя — локаль обязана его перевести.
// Незнакомый код отдаём как есть: это уже текст от сервера.
import { t } from "../i18n.js";

export function saveErrorText(code: unknown, key: string): string {
  const byCode: Record<string, string> = {
    "invalid-value": t("web.settings.invalid_value", { key }),
    "unknown-key": t("web.settings.unknown_key", { key }),
    "read-only": t("web.settings.read_only", { key }),
  };
  const raw = String(code ?? "");
  return byCode[raw] ?? raw;
}
