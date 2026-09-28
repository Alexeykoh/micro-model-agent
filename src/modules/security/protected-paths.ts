// Soft-guard чувствительных путей (.git, .env, ключи): всегда включён, требует подтверждения.
// Не жёсткий блок — тул возвращает директиву «спроси пользователя».
import { resolve, relative } from "path";
import { toForwardSlash } from "../../tools/path-utils";
import { logSecurityBlock } from "./audit-log";
import { t } from "../../i18n/index";

/**
 * Чувствительные пути, требующие явного подтверждения (внутренности VCS + секреты/env).
 * Гард ВСЕГДА ВКЛЮЧЁН, независимо от `security.paths.enabled`, — удаление `.git/config`
 * или перезапись `.env`/ключей необратимы. Не хард-блок: тул возвращает директиву
 * «спроси пользователя и жди».
 */
const DIR_PATTERNS = [".git", ".hg", ".svn"];

const EXACT_BASENAMES = [
  ".env",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  ".gitconfig",
];

const ENV_PREFIX = ".env.";

const EXT_PATTERNS = [
  ".key",
  ".pem",
  ".p12",
  ".pfx",
  ".crt",
  ".cer",
  ".secret",
  ".token",
];

/**
 * Совпавший защищённый паттерн для `targetPath` (относительно `baseDir`)
 * или `undefined` для обычного пути. Сравнение регистронезависимо
 * и не зависит от сепаратора (win32-safe).
 */
export function matchProtectedPath(baseDir: string, targetPath: string): string | undefined {
  const rel = toForwardSlash(relative(resolve(baseDir), resolve(targetPath))).toLowerCase();
  if (!rel) return undefined;

  for (const dir of DIR_PATTERNS) {
    if (rel === dir || rel.endsWith(`/${dir}`) || rel.startsWith(`${dir}/`) || rel.includes(`/${dir}/`)) {
      return `${dir}/`;
    }
  }

  const parts = rel.split("/");
  const base = parts[parts.length - 1] ?? "";

  for (const name of EXACT_BASENAMES) {
    if (base === name) return name;
  }
  if (base.startsWith(ENV_PREFIX)) return ".env.*";
  for (const ext of EXT_PATTERNS) {
    if (base.endsWith(ext)) return `*${ext}`;
  }

  return undefined;
}

/**
 * Гард для мутирующих файловых тулов: отказ «спроси пользователя» + запись в аудит,
 * `undefined` — путь обычный. Не хард-блок: пользователь вправе разрешить.
 */
export function protectedPathBlock(
  ctx: { sessionId?: string; baseDir: string },
  targetPath: string,
  pathLabel: string,
  action: "file_write" | "file_delete" = "file_write",
): { success: false; output: string } | undefined {
  const pattern = matchProtectedPath(ctx.baseDir, targetPath);
  if (!pattern) return undefined;
  logSecurityBlock(ctx.sessionId, action, `Protected path: ${pattern}`, pathLabel);
  return {
    success: false,
    output: `[PROTECTED PATH] ${t("file.protected_path_ask", { path: pathLabel, pattern })}`,
  };
}
