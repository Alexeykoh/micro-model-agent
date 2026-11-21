/**
 * RCV-3/4/5: гейт recovery-сабагента. Зовётся после пакета тулов, когда там
 * была детерминированная ошибка валидации. Исправленный вызов исполняется
 * через переданный `execute` — это `ToolExecutor.execute()` в точке сборки
 * цикла, то есть общая точка enforcement'а без обходов.
 */
import type { StopReason } from "../../core/types";
import type { LoopState } from "../../core/api";
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
  RECOVERY_MAX_TERMINALS,
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
  /** RCV-9: вылечить failure-based терминал, чтобы ход продолжился. */
  recoverTerminal(
    reason: StopReason,
    state: LoopState,
    input: string,
    call: ToolCall,
    result: ToolResult,
    execute: (call: ToolCall) => Promise<ToolResult>,
  ): Promise<boolean>;
  total(): number;
}

export function createRecoveryGate(deps: RecoveryGateDeps): RecoveryGate {
  const perSignature = new Map<string, number>();
  let total = 0;
  let terminalUsed = 0;

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

    async recoverTerminal(reason, state, input, call, result, execute): Promise<boolean> {
      if (terminalUsed >= RECOVERY_MAX_TERMINALS) return false;
      terminalUsed++;
      const failures = [...state.toolFailureCounts.entries()]
        .map(([name, v]) => `${name}: ${v.samples.join(" | ") || v.error}`)
        .join("\n")
        .slice(0, 1200);
      const error = [
        `HARNESS TERMINAL: ${reason}`,
        `LAST ERROR: ${String(result.output ?? "").slice(0, 600)}`,
        `KNOWN FAILURES: ${failures}`,
      ].join("\n");
      log("recovery_attempt", "degraded", `terminal ${reason}: ${String(result.output ?? "").slice(0, 120)}`);
      let proposal: import("./client").RecoveryProposal | null = null;
      try {
        proposal = await deps.client.propose(
          { task: input, tool: call.name, args: call.arguments, error, availableTools: deps.availableTools },
          undefined,
        );
      } catch (err) {
        log("recovery_result", "failed", `terminal proposal threw: ${String(err)}`);
        return false;
      }
      if (!proposal || "skip" in proposal) {
        log("recovery_result", "degraded", proposal?.reason || "no terminal proposal");
        return false;
      }
      const corrected: ToolCall = {
        id: `${call.id}-term${terminalUsed}`,
        name: proposal.call.name,
        arguments: proposal.call.arguments,
      };
      try {
        const outcome = await execute(corrected);
        log("recovery_result", outcome.success ? "ok" : "failed", `terminal exec ${corrected.name}: ${String(outcome.output ?? "").slice(0, 160)}`);
        return outcome.success;
      } catch (err) {
        log("recovery_result", "failed", `terminal execute threw: ${String(err)}`);
        return false;
      }
    },
  };
}
