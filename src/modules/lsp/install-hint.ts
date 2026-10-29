// Подсказки установки LSP-серверов: что именно поставить, чтобы сервер ожил.
//
// Вынесено из `diagnose-server.ts` (правило ≤300): резолв пакетов, пины под
// версии проекта и нативные установщики — самостоятельный шов, не диагностика.
import type { LspServerConfig } from "./types";
import type { ProjectToolchain } from "./toolchain";
import type { LspFailureReason } from "./failure-reason";
import { pinForOldNode } from "./node-version";

/** Нативные установщики LSP-серверов, которым npx не подходит. */
const NATIVE_INSTALL: Record<string, string> = {
  "rust-analyzer": "rustup component add rust-analyzer",
  gopls: 'go install golang.org/x/tools/gopls@latest',
};

/** Имя и версия npx-пакета: `typescript@5` → [`typescript`, `5`]. */
function splitPackage(pkg: string): [name: string, version: string | undefined] {
  const at = pkg.lastIndexOf("@");
  return at > 0 ? [pkg.slice(0, at), pkg.slice(at + 1)] : [pkg, undefined];
}

/**
 * Подставить версию из тулчейна проекта к npx-пакету. Сервер, идущий через npx,
 * не должен тянуть «последнюю» версию, несовместимую с рантаймом проекта: если
 * проект объявляет версию этого пакета — берём её.
 */
function pinPackage(pkg: string, toolchain?: ProjectToolchain): string {
  const [name] = splitPackage(pkg);
  const declared = toolchain?.packages[name];
  if (!declared) return pkg;
  const v = declared.replace(/^[\^~>=<v\s]+/, "").trim();
  return v ? `${name}@${v}` : pkg;
}

/** Команда нативной установки с учётом объявленного тулчейна (rust channel). */
function nativeInstallCommand(
  server: LspServerConfig,
  toolchain?: ProjectToolchain,
): string | null {
  const cmd = NATIVE_INSTALL[server.command] ?? null;
  if (!cmd) return null;
  if (server.command === "rust-analyzer") {
    const channel = toolchain?.runtimes.find((r) => r.name === "rust")?.version;
    return channel ? `${cmd} --toolchain ${channel}` : cmd;
  }
  return cmd;
}

/** Пакеты из npx-args (`--package X`), дедуп с сохранением порядка. */
export function npxPackages(args: string[] | undefined): string[] {
  const list = args ?? [];
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "--package" && list[i + 1]) {
      const pkg = list[i + 1];
      if (!out.includes(pkg)) out.push(pkg);
      i++;
    }
  }
  return out;
}

/**
 * Команда установки, совместимой с текущим (старым) Node: тот же пакет, но
 * запиненный до сборки, которая запускается. Повторная установка latest — это
 * ровно та версия, которая только что упала, поэтому советовать её нельзя.
 */
function oldNodeInstall(server: LspServerConfig, toolchain?: ProjectToolchain): string | null {
  const pkgs = npxPackages(server.args);
  if (pkgs.length === 0) return null;
  const pinned = pkgs.map((p) => pinForOldNode(pinPackage(p, toolchain)));
  return `npm i -g ${pinned.join(" ")}`;
}

/**
 * Команда ручной глобальной установки сервера. Заполняется только когда это
 * реально помогает: сервер идёт через `npx` (медленный старт), глобального
 * бинарника нет, или рантайм не подходит текущей версии. Уже глобальный и
 * работающий сервер — `null`. Версии пакетов и для нативных серверов берутся из
 * объявленного тулчейна проекта (все языки), чтобы не советовать сборку под
 * чужой рантайм.
 */
export function installCommandFor(
  server: LspServerConfig,
  reason: LspFailureReason,
  useNpxFallback: boolean,
  toolchain?: ProjectToolchain,
): string | null {
  // Крах на рантайме лечится пином, а не повторной установкой той же версии.
  if (reason === "node-too-old") return oldNodeInstall(server, toolchain);
  const useful =
    useNpxFallback || reason === "binary-missing" || reason === "offline" || reason === "network";
  if (!useful) return null;
  const pkgs = npxPackages(server.args);
  if (pkgs.length > 0) return `npm i -g ${pkgs.map((p) => pinPackage(p, toolchain)).join(" ")}`;
  return nativeInstallCommand(server, toolchain);
}
