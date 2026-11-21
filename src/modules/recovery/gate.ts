/**
 * RCV-3/4/5: гейт recovery-сабагента. Зовётся после пакета тулов, когда там
 * была детерминированная ошибка валидации. Исправленный вызов исполняется
 * через переданный `execute` — это `ToolExecutor.execute()` в точке сборки
 * цикла, то есть общая точка enforcement'а без обходов.
 */
import type { Logger } from "../../logger/app-logger";
import type { SessionLogger } from "../../core/session-logger";
import type { ToolCall } from "../../core/types";
import type { ToolResult } from "../../tools/types";
import { isValidationFailure } from "../../core/api";
import { RecoveryClient } from "./client";
import {
  RECOVERY_AFTER_FAILURES,
  RECOVERY_MAX_PER_SIGNATURE,
  RECOVERY_MAX_PER_TURN,
} from "./constants";

export interface RecoveryGateDeps {
  /** Интерфейс, а не класс: тесты подменяют клиент без unsafe-кастов. */
  client: { propose: RecoveryClient["propose"] };
  execute: (call: ToolCall) => Promise<ToolResult>;
  availableTools: string[];
  slog?: Pick<SessionLogger, "logDiagnosticEvent">;
  logger: Pick<Logger, "diagnostic">;
}

export interface RecoveryGate {
  maybeRecover(
    call: ToolCall,
    result: ToolResult,
    input: string,
    execute?: (call: ToolCall) => Promise<ToolResult>,
  ): Promise<ToolResult | null>;
  total(): number;
}

export function createRecoveryGate(deps: RecoveryGateDeps): RecoveryGate {
  const perSignature = new Map<string, number>();
  let total = 0;

  const log = (event: "recovery_attempt" | "recovery_result", kind: "ok" | "failed" | "degraded", cause: string): void => {
    deps.slog?.logDiagnosticEvent(event, {
      source: "module:recovery",
      operation: event === "recovery_attempt" ? "recovery.call" : "recovery.exec",
      kind,
      cause,
    });
    deps.logger.diagnostic(kind === "ok" ? "info" : "warn", `${event}: ${cause}`);
  };

  return {
    total: () => total,

    async maybeRecover(call, result, input, execute): Promise<ToolResult | null> {
      const run = execute ?? deps.execute;
      if (result.success || !isValidationFailure(result)) return null;
      const signature = `${call.name}:validation`;
      const seen = (perSignature.get(signature) ?? 0) + 1;
      perSignature.set(signature, seen);
      if (seen < RECOVERY_AFTER_FAILURES || total >= RECOVERY_MAX_PER_TURN) return null;
      if (seen > RECOVERY_MAX_PER_SIGNATURE) return null;

      total++;
      log("recovery_attempt", "degraded", `${signature} #${seen}: ${String(result.output ?? "").slice(0, 160)}`);
      let proposal: import("./client").RecoveryProposal | null = null;
      try {
        proposal = await deps.client.propose(
          {
            task: input,
            tool: call.name,
            args: call.arguments,
            error: String(result.output ?? ""),
            availableTools: deps.availableTools,
          },
          undefined,
        );
      } catch (err) {
        log("recovery_result", "failed", `proposal threw: ${String(err)}`);
        return null;
      }
      if (!proposal) {
        log("recovery_result", "degraded", "no proposal");
        return null;
      }
      if ("skip" in proposal) {
        log("recovery_result", "degraded", proposal.reason || "skipped");
        return null;
      }
      const corrected: ToolCall = {
        id: `${call.id}-rc${seen}`,
        name: proposal.call.name,
        arguments: proposal.call.arguments,
      };
      try {
        const outcome = await run(corrected);
        log("recovery_result", outcome.success ? "ok" : "failed", `${corrected.name}: ${String(outcome.output ?? "").slice(0, 160)}`);
        return outcome;
      } catch (err) {
        log("recovery_result", "failed", `execute threw: ${String(err)}`);
        return null;
      }
    },
  };
}
