/**
 * `EgressGuard` — конкретная реализация политики (спека §3.1). Одна точка
 * редактирования для обеих поверхностей: E1 (провайдер) и E2 (API). Fail-closed
 * (INV-D4): ошибка/неудача классификатора прерывает внешний вызов типизированной
 * ошибкой, если `failClosed`; иначе fail-open с записью.
 */
import type { PolicyContext } from "./context";
import type { DataPolicyConfig, DataClass, EgressGuard, EgressTarget, GuardDiagnostic } from "./types";
import { projectDeep, projectText, type ProjectPolicy } from "./project";
import { rehydrate, TokenMap } from "./tokens";

/** Типизированная ошибка пресечения (recoverable-диагностика, INV-D4). */
export class EgressBlockedError extends Error {
  readonly module = "security.data-policy";
  readonly operation = "egress.sanitize";
  readonly kind = "egress_blocked";
  constructor(reason: string) {
    super(`Egress blocked: ${reason}`);
    this.name = "EgressBlockedError";
  }
}

export interface CreateGuardOptions {
  config: DataPolicyConfig;
  target: EgressTarget;
  ctx: PolicyContext;
  /** Общая карта токенов сессии (шарится форками, INV-D11). */
  map?: TokenMap;
  onDiagnostic?: (d: GuardDiagnostic) => void;
}

/** Создать guard для заданной цели. */
export function createGuard(opts: CreateGuardOptions): EgressGuard<unknown, unknown> {
  const { config, target, ctx } = opts;
  const map = opts.map ?? new TokenMap();
  const policy: ProjectPolicy = { config, target, ctx, map };

  const diag = (d: Omit<GuardDiagnostic, "module">): void => {
    opts.onDiagnostic?.({ module: "security.data-policy", ...d });
  };

  const sumStats = (
    acc: Partial<Record<DataClass, number>>,
    add: Partial<Record<DataClass, number>>,
  ): Partial<Record<DataClass, number>> => {
    for (const [k, n] of Object.entries(add)) {
      acc[k as DataClass] = (acc[k as DataClass] ?? 0) + (n ?? 0);
    }
    return acc;
  };

  const guard: EgressGuard<unknown, unknown> = {
    target,
    sanitizeChat(messages, tools) {
      if (!config.enabled) return { messages, tools, changed: false, stats: {} };
      try {
        const stats: Partial<Record<DataClass, number>> = {};
        const msgProj = projectDeep(messages, policy);
        sumStats(stats, msgProj.stats);
        let toolsOut = tools;
        let changed = msgProj.changed;
        if (tools) {
          const toolProj = projectDeep(tools, policy);
          toolsOut = toolProj.messages;
          sumStats(stats, toolProj.stats);
          changed = changed || toolProj.changed;
        }
        if (changed) diag({ operation: "sanitizeChat", kind: "egress", outcome: "redacted", count: Object.values(stats).reduce((a, b) => a + b, 0) });
        return { messages: msgProj.messages, tools: toolsOut, changed, stats };
      } catch (e) {
        if (config.failClosed) {
          diag({ operation: "sanitizeChat", kind: "egress", outcome: "aborted" });
          throw new EgressBlockedError(e instanceof Error ? e.message : String(e));
        }
        diag({ operation: "sanitizeChat", kind: "egress", outcome: "passed" });
        return { messages, tools, changed: false, stats: {} };
      }
    },
    rehydrateArgs(rawArgs) {
      return rehydrate(rawArgs, map);
    },
    filterClient(payload) {
      if (!config.enabled) return payload;
      try {
        return projectDeep(payload, policy).messages;
      } catch (e) {
        if (config.failClosed) throw new EgressBlockedError(e instanceof Error ? e.message : String(e));
        return payload;
      }
    },
    onDiagnostic: opts.onDiagnostic,
  };

  return guard;
}

/** Экспорт для тестов/утилит: проекция одной строки. */
export { projectText };
