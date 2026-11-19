/**
 * One-shot `mma "prompt" --daemon <url>` (split W5): промпт исполняет демон
 * через job API, локальный `Agent`/`SessionManager` не поднимается.
 *
 * Вывод — терминальный Job-объект: текст модели печатается после завершения
 * (в отличие от локального one-shot, где текст стримится живьём). `--json`
 * отдаёт тот же машиночитаемый документ, что и локальный прогон.
 */
import { getDefaultChannel, writeMachineJson } from "../output";
import type { AgentResult } from "../core/types";
import { errMsg } from "../utils";
import { buildJsonResult } from "./json-payload";
import { printRunResult } from "./run-result";
import { RemoteHost } from "../modules/daemon/remote-host";
import { RemoteTasksClient, type RemoteJobObject } from "../modules/daemon/remote-tasks";
import { readDaemonToken } from "../modules/daemon/protocol";
import { resolveDaemonSession } from "./daemon-session";

/** Вход one-shot-ветки к демону. */
export interface DaemonOneShotOptions {
  url: string;
  prompt: string;
  json: boolean;
}

/** Исполняет промпт на демоне и завершает процесс кодом результата. */
export async function runDaemonOneShot(opts: DaemonOneShotOptions): Promise<never> {
  if (opts.json) getDefaultChannel().setQuiet(true);
  const token = readDaemonToken();
  const host = new RemoteHost({ baseUrl: opts.url, token });
  try {
    const sessionId = await resolveDaemonSession(host);
    const job = await new RemoteTasksClient({ baseUrl: opts.url, token }).run(
      sessionId,
      opts.prompt,
    );
    const result = toAgentResult(job);
    if (!opts.json && result.success && result.text) {
      getDefaultChannel().writeLine(result.text);
    }
    if (opts.json) writeMachineJson(buildJsonResult(result, []));
    process.exit(printRunResult(result, () => {}));
  } catch (err) {
    const result: AgentResult = {
      success: false,
      text: "",
      error: errMsg(err),
      iterationCount: 0,
    };
    if (opts.json) writeMachineJson(buildJsonResult(result, []));
    process.exit(printRunResult(result, () => {}));
  } finally {
    host.dispose();
  }
}

/** Job-объект → `AgentResult` для общей печати и `--json`. */
function toAgentResult(job: RemoteJobObject): AgentResult {
  const success = job.status === "succeeded";
  const usage = job.usage;
  return {
    success,
    text: job.result?.text ?? "",
    ...(success ? {} : { error: job.error?.detail ?? job.error?.title ?? `task ${job.status}` }),
    iterationCount: 0,
    ...(usage
      ? {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.promptTokens + usage.completionTokens,
          totalCost: usage.costUsd,
        }
      : {}),
  };
}
