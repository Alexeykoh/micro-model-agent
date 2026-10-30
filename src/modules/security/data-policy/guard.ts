/**
 * `EgressGuard` — конкретная реализация политики (спека §3.1). Одна точка
 * редактирования для обеих поверхностей: E1 (провайдер) и E2 (API). Fail-closed
 * (INV-D4): ошибка/неудача классификатора прерывает внешний вызов типизированной
 * ошибкой, если `failClosed`; иначе fail-open с записью.
 */
import type { PolicyContext } from "./context";
import type {
  DataPolicyConfig,
  DataClass,
  EgressGuard,
  EgressTarget,
  GuardDiagnostic,
} from "./types";
import { projectDeep, projectText, type ProjectPolicy } from "./project";
import { projectToolDefs, restoreToolNames } from "./project-tools";
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

/** image_url-часть сообщения: URL/data-URL может нести локальный путь/PII. */
function isImagePart(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "image_url";
}

/**
 * Вырезать image_url-части (E1, только для внешнего egress без явного
 * разрешения `allowImagesToExternal`). Массив, от которого остались только
 * изображения, заменяется текстовой заглушкой — пустой content ломает
 * OpenAI-совместимых провайдеров.
 */
function stripImageParts<T>(value: T): { value: T; removed: boolean } {
  let removed = false;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      let localRemoved = false;
      for (const item of v) {
        if (isImagePart(item)) {
          removed = true;
          localRemoved = true;
          continue;
        }
        out.push(walk(item));
      }
      if (localRemoved && out.length === 0 && v.length > 0) {
        return { type: "text", text: "[image removed]" };
      }
      return out;
    }
    if (v && typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(src)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, removed };
}

/** Создать guard для заданной цели. */
export function createGuard(opts: CreateGuardOptions): EgressGuard<unknown, unknown> {
  const { config, target, ctx } = opts;
  const map = opts.map ?? new TokenMap();
  const policy: ProjectPolicy = { config, target, ctx, map };

  const diag = (d: Omit<GuardDiagnostic, "module" | "target">): void => {
    opts.onDiagnostic?.({ module: "security.data-policy", target, ...d });
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
        // Внешнему провайдеру изображения уходят только по явному разрешению
        // (INV-D2): иначе URL/data-URL изображения — ещё один канал утечки.
        const stripped =
          !target.trusted && !config.allowImagesToExternal
            ? stripImageParts(messages)
            : { value: messages, removed: false };
        const msgProj = projectDeep(stripped.value, policy);
        sumStats(stats, msgProj.stats);
        const tokens = [...msgProj.tokens];
        let toolsOut = tools;
        let changed = msgProj.changed || stripped.removed;
        if (tools) {
          // Идентификаторы тулов неприкосновенны (INV-DLP-9): отдельная
          // проекция, а не слепой `projectDeep` по всей структуре (A11).
          const toolProj = projectToolDefs(tools, policy);
          const repaired = restoreToolNames(tools, toolProj.tools);
          toolsOut = repaired.tools;
          sumStats(stats, toolProj.stats);
          tokens.push(...toolProj.tokens);
          changed = changed || toolProj.changed;
          // Защитный барьер: если имя всё же изменилось — оно уже восстановлено,
          // но факт обязан попасть в диагностику (не молча, INV-15).
          for (const issue of repaired.issues) {
            diag({
              operation: "sanitizeChat",
              kind: "tool-name-integrity",
              outcome: "passed",
              count: 1,
              cause: issue,
            });
          }
        }
        if (changed) {
          diag({
            operation: "sanitizeChat",
            kind: "egress",
            outcome: "redacted",
            count: Object.values(stats).reduce((a, b) => a + b, 0),
            stats,
            tokens,
          });
        }
        return { messages: msgProj.messages, tools: toolsOut, changed, stats };
      } catch (e) {
        const cause = e instanceof Error ? e.message : String(e);
        if (config.failClosed) {
          diag({ operation: "sanitizeChat", kind: "egress", outcome: "aborted", cause });
          throw new EgressBlockedError(cause);
        }
        diag({ operation: "sanitizeChat", kind: "egress", outcome: "passed", cause });
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
        const cause = e instanceof Error ? e.message : String(e);
        if (config.failClosed) {
          diag({ operation: "filterClient", kind: "egress", outcome: "aborted", cause });
          throw new EgressBlockedError(cause);
        }
        diag({ operation: "filterClient", kind: "egress", outcome: "passed", cause });
        return payload;
      }
    },
    onDiagnostic: opts.onDiagnostic,
  };

  return guard;
}

/** Экспорт для тестов/утилит: проекция одной строки. */
export { projectText };
