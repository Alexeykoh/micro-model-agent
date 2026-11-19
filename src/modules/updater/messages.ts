// Человекочитаемый итог установки (STYLE.md: `⚠ что — причина` + `↳ что делать`).
//
// Сырая ошибка Node (`EACCES: permission denied, rm '…'`, `shasum mismatch`) —
// материал session-лога, а не чата: пользователю нужна причина на русском и одна
// команда, которая действительно чинит ситуацию. Единая точка классификации
// держит тексты проверяемыми тестом, а не размазанными по `module.ts`.
import { homedir } from "node:os";
import { t } from "../../i18n/index";
import { installScriptCommand } from "./release";

/** Сырой технический текст, ужатый до одной строки (для неизвестных ошибок). */
const MAX_CAUSE = 160;

export function shortCause(raw: string): string {
  const line = (raw.split("\n")[0] ?? "").trim();
  return line.length > MAX_CAUSE ? `${line.slice(0, MAX_CAUSE - 1)}…` : line;
}

/** Домашний каталог → `~`, чтобы путь в чате был коротким и одинаковым на ОС. */
export function tildePath(path: string): string {
  const home = homedir();
  if (!path.startsWith(home)) return path;
  return `~${path.slice(home.length).replace(/\\/g, "/")}`;
}

/**
 * Причина отказа установки человеческим языком. Порядок проверок важен:
 * `size mismatch` содержит «mismatch», поэтому проверки целостности идут до
 * сетевых, а `unsupported platform` — до общего HTTP-паттерна.
 */
export function classifyInstallError(error: string, installRoot: string): string {
  const e = error.toLowerCase();
  if (e.includes("checksum") || e.includes("size mismatch")) return t("updater.cause_corrupt");
  if (e.includes("eacces") || e.includes("eperm") || e.includes("permission denied")) {
    return t("updater.cause_perm", { dir: tildePath(installRoot) });
  }
  if (e.includes("enospc") || e.includes("no space")) return t("updater.cause_disk");
  if (e.includes("unsupported platform") || e.includes("not in the manifest")) {
    return t("updater.cause_platform");
  }
  if (e.includes("http 404")) return t("updater.cause_no_release");
  if (e.includes("http 5") || e.includes("timeout") || e.includes("fetch") || e.includes("socket")) {
    return t("updater.cause_net");
  }
  return t("updater.cause_unknown", { error: shortCause(error) });
}

/** Полный текст отказа: строка «что + причина» и одна подсказка с командой. */
export function installFailureText(
  latest: string,
  error: string,
  installRoot: string,
  platform: string = process.platform,
): string {
  const cause = classifyInstallError(error, installRoot);
  const what = latest
    ? t("updater.install_failed", { latest, cause })
    : t("updater.install_failed_no_version", { cause });
  return [what, t("updater.install_failed_hint", { cmd: installScriptCommand(platform) })].join(
    "\n",
  );
}
