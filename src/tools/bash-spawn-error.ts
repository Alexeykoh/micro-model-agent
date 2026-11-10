/**
 * Честная классификация ошибки спавна shell-процесса (S1, спека 0.25.2).
 *
 * Проблема: Node и Bun при недоступном шелле И при несуществующем cwd пишут
 * одинаковое сообщение (`spawn …\cmd.exe ENOENT` /
 * `ENOENT: no such file or directory, uv_spawn '…\cmd.exe'`) — путь в сообщении
 * это шелл, а не cwd. Поэтому текст сообщения сам по себе причину не различает,
 * и `workdir` проверяется отдельно: если каталога нет, это и есть причина.
 * Иначе харнесс отправлял модель чинить workdir, который в порядке.
 */
import { existsSync } from "fs";
import { t } from "../i18n/index";

export type SpawnErrorClass = "shell" | "workdir" | "unknown";

/** Маркеры «процесс вообще не стартовал» (в отличие от ненулевого exit). */
const ENOENT_MARKERS = ["enoent", "no such file", "uv_spawn"];

/** Имена шеллов по платформам: только они отличают «сломан шелл» от прочего. */
const SHELL_MARKERS: Record<string, string[]> = {
  win32: ["cmd.exe", "comspec", "powershell", "pwsh"],
  linux: ["/bin/sh", "/bin/bash", "bash", "zsh", "fish"],
  darwin: ["/bin/sh", "/bin/bash", "bash", "zsh", "fish"],
};

function mentionsPath(message: string, target: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/\\/g, "/");
  return normalize(message).includes(normalize(target));
}

/**
 * Классифицирует `entry.spawnError`. `workdir` опционален, но без него
 * невозможно отличить недоступный шелл от несуществующего cwd (см. шапку).
 */
export function classifySpawnError(
  message: string,
  platform: NodeJS.Platform,
  workdir?: string,
): SpawnErrorClass {
  const msg = message.toLowerCase();
  const enoent = ENOENT_MARKERS.some((m) => msg.includes(m));
  // Сообщение прямо называет workdir — причина очевидна.
  if (workdir && mentionsPath(msg, workdir)) return "workdir";
  // Сообщение называет шелл, а cwd нет на диске — Node/Bun сообщили путь шелла.
  if (workdir && enoent && !existsSync(workdir)) return "workdir";
  const shell = SHELL_MARKERS[platform] ?? [];
  if (enoent && shell.some((m) => msg.includes(m))) return "shell";
  return "unknown";
}

/**
 * Текст для модели: шелл недоступен, все shell-вызовы упадут одинаково.
 * Без ложного «проверь workdir» — в этом и смысл S1.
 */
export function shellUnavailableOutput(spawnError?: string): string {
  const guidance = t("bash.shell_unavailable");
  return spawnError ? `[process error] ${spawnError}\n${guidance}` : guidance;
}
