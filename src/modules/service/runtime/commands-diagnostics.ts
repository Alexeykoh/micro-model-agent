/**
 * `/diagnostics` — отчёт о состоянии демона (split W13).
 *
 * Это диагностика runtime-процесса (модули, очередь, сессии, uptime), а не
 * локальной установки CLI: `/doctor` остаётся терминальным и проверяет
 * окружение пользователя. Сбор синхронный и ограничен try/catch на модуль —
 * зависший health не должен блокировать HTTP-ответ.
 */
import { readMmaVersion } from "../../../core/version";
import { fail, ok, type CommandCtx } from "./commands-types";

interface HealthLike {
  health?: () => { status: string; reason?: string };
}

/** Строка модуля: имя + health, иначе `not wired`. */
function moduleLine(name: string, module: HealthLike | undefined): string {
  if (!module) return `${name}: not wired`;
  if (typeof module.health !== "function") return `${name}: available`;
  try {
    const health = module.health();
    return `${name}: ${health.status}${health.reason ? ` (${health.reason})` : ""}`;
  } catch (err) {
    return `${name}: error (${err instanceof Error ? err.message : String(err)})`;
  }
}

/** `/diagnostics` — версия, workspace, лимиты, модули, очередь. */
export function diagnosticsCommand(ctx: CommandCtx): ReturnType<typeof ok> {
  const s = ctx.s;
  const manager = s.deps.sessionManager;
  if (!manager) return fail("sessions unavailable");
  const uptimeSec = Math.round((Date.now() - s.startedAt) / 1000);
  const lines = [
    `version: ${readMmaVersion()}`,
    `workspace: ${s.deps.baseDir ?? process.cwd()}`,
    `model: ${s.config.model} · provider: ${s.config.provider.active ?? s.config.provider.type}`,
    `uptime: ${uptimeSec}s · busy: ${s.pool.anyBusy()} · queued: ${s.pool.totalQueued()}`,
    `sessions: ${manager.list().length} · pending questions: ${s.pendingQuestions.size}`,
    moduleLine("memory", s.deps.memory as HealthLike | undefined),
    moduleLine("skills", s.deps.skills as HealthLike | undefined),
    moduleLine("indexer", s.deps.indexer as HealthLike | undefined),
    moduleLine("lsp", s.deps.lsp as HealthLike | undefined),
    moduleLine("plugins", s.deps.plugins as HealthLike | undefined),
    moduleLine("updater", s.deps.updater as HealthLike | undefined),
  ];
  return ok(...lines);
}
