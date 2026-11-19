// Пути проверок плана: раскрытие переменных окружения и тот же вердикт, что у тулов.
import { homedir } from "os";
import type { PathSecurityConfig } from "../../config/types";
import type { ToolScope } from "../../tools/types";
import { isPathInScope } from "../security/path-validator";
import { t } from "../../i18n/index";

/** Окружение для раскрытия `%VAR%`/`$VAR`; инжектится в тестах. */
export interface ExpandPathOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Раскрывает `~`, `%VAR%` (Windows) и `$VAR`/`${VAR}` без запуска shell.
 * Неизвестная переменная остаётся как есть — путь не «магически» не находится
 * и не подменяется пустой строкой.
 */
export function expandPath(raw: string, opts: ExpandPathOptions = {}): string {
  if (!raw) return raw;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();

  let out = raw.trim();
  if (out === "~" || out.startsWith("~/") || out.startsWith("~\\")) {
    out = home + out.slice(1);
  }
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name: string) => env[name] ?? match);
  out = out.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced: string | undefined, plain: string | undefined) => {
      const name = braced ?? plain;
      return name ? (env[name] ?? match) : match;
    },
  );
  return out;
}

/** Итог резолва пути проверки: абсолютный путь + сообщение отказа (null — можно). */
export interface CheckPathResolution {
  path: string;
  blocked: string | null;
}

/**
 * Резолвит путь проверки плана через `path-validator` — тот же вердикт, что у
 * тулов (INV-9/10). `securityConfig === undefined` — легаси-режим без jail:
 * конструктор `StepVerifier` в юнит-тестах создаётся без конфига, и ломать его
 * нельзя. Наличие секции (включая `enabled:false`) включает политику.
 */
export function resolveCheckPath(
  baseDir: string,
  rawPath: string,
  scope?: ToolScope,
  securityConfig?: PathSecurityConfig,
): CheckPathResolution {
  const path = expandPath(rawPath);
  if (!securityConfig) return { path, blocked: null };

  const verdict = isPathInScope(baseDir, path, scope, securityConfig);
  if (verdict.allowed) return { path, blocked: null };

  const outside = /outside the base working directory/.test(verdict.reason ?? "");
  const message = outside
    ? t("verify.path_outside_base", { path })
    : t("verify.path_blocked", { path, reason: verdict.reason ?? "" });
  return { path, blocked: message };
}
