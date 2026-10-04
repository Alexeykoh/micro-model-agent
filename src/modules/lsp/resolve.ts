// Резолв запуска LSP-сервера: npx→глобальный бинарник, поиск в PATH, офлайн-флаг.
import { execSync } from "child_process";
import { platform } from "os";
import { readEnv } from "../../config/env";

/**
 * Имя реального бинарника из npx-args — только строгий layout
 * `[--yes] [--package X]... <binary> --stdio`. Серверы с хвостовыми
 * серверными аргументами (напр. angular `ngserver --stdio --tsProbeLocations …`)
 * дают null и всегда идут через npx — их флаги не принять за бинарник
 * и не вырезать.
 */
export function extractBinaryFromNpxArgs(args: string[]): string | null {
  const stdioIdx = args.lastIndexOf("--stdio");
  if (stdioIdx !== args.length - 1 || stdioIdx < 1) return null;
  const binary = args[stdioIdx - 1];
  if (!binary || binary.startsWith("-") || isPackageVersion(binary)) return null;
  for (let i = 0; i < stdioIdx - 1; i++) {
    const a = args[i];
    if (a === "--yes") continue;
    if (a === "--package") {
      i++;
      continue;
    }
    return null;
  }
  return binary;
}

/** Похоже ли на спецификатор версии пакета (напр. "typescript@5"). */
export function isPackageVersion(s: string): boolean {
  return /^[\w-]+@[\d.+*-]/.test(s);
}

/** Путь бинарника в PATH или null (where/which, таймаут 3с). */
export function findOnPath(name: string): string | null {
  const cmd = platform() === "win32" ? `where ${name}` : `which ${name}`;
  try {
    const out = execSync(cmd, { stdio: "pipe", timeout: 3000 }).toString().trim();
    return out.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

/**
 * Офлайн-режим LSP (`MMA_LSP_OFFLINE`): не использовать npx совсем.
 * Env сильнее конфига: задан явно — берётся он; иначе — флаг `configOffline`
 * (`config.lsp.offline`, выключатель в UI). Ложные значения `0`/`false`/`no`/пусто
 * у env означают «выключено», перекрывая конфиг.
 */
export function isOfflineLsp(env?: NodeJS.ProcessEnv, configOffline?: boolean): boolean {
  const raw = readEnv("LSP_OFFLINE", env);
  if (raw === undefined) return configOffline === true;
  const v = raw.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no";
}

/** Итог резолва npx-команды: эффективные команда/args и признак npx-фолбэка. */
export interface NpxLaunch {
  command: string;
  args: string[];
  binaryName: string | null;
  binaryOnPath: boolean;
  useNpxFallback: boolean;
}

/**
 * Резолв npx-запуска: если args строгого layout и бинарник есть в PATH —
 * запуск напрямую, иначе npx. Не-npx команды не трогает.
 * `probe` инжектируется для тестов (по умолчанию `findOnPath`).
 */
export function resolveNpxLaunch(
  command: string,
  args: string[],
  probe: (name: string) => string | null = findOnPath,
): NpxLaunch {
  if (command !== "npx" || args.length === 0) {
    return { command, args, binaryName: null, binaryOnPath: false, useNpxFallback: false };
  }
  const binaryName = extractBinaryFromNpxArgs(args);
  if (binaryName && probe(binaryName)) {
    const stripped = args.filter(
      (a) => a !== "--yes" && a !== "--package" && a !== binaryName && !isPackageVersion(a),
    );
    return {
      command: binaryName,
      args: stripped,
      binaryName,
      binaryOnPath: true,
      useNpxFallback: false,
    };
  }
  return { command, args, binaryName, binaryOnPath: false, useNpxFallback: true };
}
