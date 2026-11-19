// One-shot прогон `mma "<промпт>"`: bootstrap, человеческий вывод и `--json`.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bootstrap } from "../core/bootstrap";
import { getDefaultChannel, defaultOutputBus, JsonOutputSink, writeMachineJson } from "../output";
import { buildJsonError, buildJsonResult } from "./json-payload";
import { printRunResult } from "./run-result";
import { Renderer } from "../ui/renderer";
import { resolveVerbosity } from "../ui/theme";
import { startAutoUpdate } from "./auto-update";
import { applyLogVisibility } from "./log-visibility";
import { globalMmaDir } from "../config/paths";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { errMsg } from "../utils";
import type { AgentResult } from "../core/types";

/**
 * Взведён только для one-shot `--json`-прогонов (позиционный промпт есть). На уровне
 * модуля, чтобы топ-уровневый `main().catch` отдал валидный документ, даже когда
 * `bootstrap` (или что-то до JSON-ветки) бросил с пустым stdout. Интерактивный
 * `mma --json` (без промпта) его не ставит, иначе краш REPL эмитил бы JSON.
 */
let jsonMode = false;

/** True, когда текущий прогон — one-shot `--json` (для топ-уровневого catch). */
export function isJsonMode(): boolean {
  return jsonMode;
}

/** Вход one-shot ветки: промпт и уже разобранные опции CLI. */
export interface OneShotParams {
  prompt: string;
  projectDir?: string;
  noAgentsMd: boolean;
  exitOnComplete: boolean;
  reasoningLevel?: string;
  verbose: boolean;
  contextLog: boolean;
  json: boolean;
}

/**
 * Прогоняет один промпт и завершает процесс кодом результата (`0` успех,
 * `1` ошибка/провал). В `--json`-режиме ни один сырой стек не попадает в stdout:
 * и AbortError, и рухнувший тул дают валидный машиночитаемый документ.
 */
export async function runOneShot(params: OneShotParams): Promise<never> {
  const { projectDir, noAgentsMd, exitOnComplete, reasoningLevel, verbose, contextLog, json } =
    params;

  // `--json` владеет stdout ТОЛЬКО в one-shot: гасим человеческий канал до
  // bootstrap, чтобы варнинги конфига не запачкали машиночитаемый документ,
  // и подписываем sink ДО bootstrap, чтобы warn/error bootstrap попали в
  // captured-диагностику. Info-нотисы миграции осознанно не каптурятся
  // (диагностика — только warn/error). Вызов без промпта (`mma --json`)
  // открывает интерактивный REPL: ни quiet, ни sink там не ставятся.
  if (json) {
    jsonMode = true;
    getDefaultChannel().setQuiet(true);
  }
  const jsonSink = json ? new JsonOutputSink(defaultOutputBus) : undefined;

  const prompt = params.prompt;
  const mmaDir = globalMmaDir();
  const { hasDomainFiles } = await import("../config/domains");
  const virgin = !existsSync(join(mmaDir, "config.json")) && !hasDomainFiles(mmaDir);
  const { agent, config, baseDir, legacyDetected, contextProbe } = await bootstrap(
    undefined,
    projectDir,
    noAgentsMd,
    exitOnComplete,
    reasoningLevel,
    contextLog,
  );
  if (verbose) config.ui.verbosity = "verbose";
  applyLogVisibility(verbose || config.ui.verbose || config.ui.verbosity === "verbose");

  if (legacyDetected) {
    getDefaultChannel().writeLine(pc.yellow(`  ${t("config.legacy_hint")}`), "stderr");
  }

  if (virgin && !json) {
    getDefaultChannel().writeLine(pc.yellow(`  ${t("cli.first_run_oneshot")}`), "stderr");
  }

  // Расхождение загруженного и настроенного контекста показываем и в one-shot
  // (раньше только Repl.start() рендерил). Под --json скипаем.
  if (contextProbe && !json) {
    try {
      const probe = await contextProbe;
      if (probe) {
        if (probe.actual < config.contextWindow) {
          getDefaultChannel().writeLine(
            pc.yellow(
              t("repl.context_probe_small", {
                model: probe.model,
                actual: String(probe.actual),
                configured: String(config.contextWindow),
              }),
            ),
          );
        } else if (probe.actual > config.contextWindow) {
          getDefaultChannel().writeLine(
            pc.dim(t("repl.context_probe_big", { model: probe.model, actual: String(probe.actual) })),
          );
        }
      }
    } catch {
      // best-effort.
    }
  }

  const updater = exitOnComplete ? undefined : startAutoUpdate(config);

  if (jsonMode) {
    let result: AgentResult;
    try {
      result = await agent.run(prompt);
    } catch (err) {
      // --json не эмитит сырые стеки никогда: и AbortError, и рухнувший
      // тул/плагин дают валидный машиночитаемый результат; shutdown/waitForIdle
      // всё равно отрабатывают.
      const message = errMsg(err);
      agent.shutdown();
      const diagnostics = jsonSink?.diagnostics() ?? [];
      jsonSink?.dispose();
      writeMachineJson(buildJsonError(message, diagnostics));
      await updater?.waitForIdle(10_000);
      process.exit(1);
    }
    agent.shutdown();
    const diagnostics = jsonSink?.diagnostics() ?? [];
    jsonSink?.dispose();
    writeMachineJson(buildJsonResult(result, diagnostics));
    await updater?.waitForIdle(10_000);
    process.exit(result.success ? 0 : 1);
  }

  // TODO(output): one-shot прогоны не показывают варнинг контекст-пробника
  // (рендерит только Repl.start()). Показать здесь, когда bootstrap отдаст
  // результат пробника в эту ветку.
  const renderer = new Renderer({
    spinner: config.ui?.spinner ?? true,
    baseDir,
    verbosity: resolveVerbosity(config.ui),
  });
  renderer.showLoader();
  let result: AgentResult;
  try {
    result = await agent.run(
      prompt,
      (chunk) => renderer.text(chunk),
      (meta) => renderer.meta(meta),
      (ev) => {
        if (ev.type === "start") {
          renderer.toolStart(ev.tool, ev.args, undefined, ev.icon);
        } else {
          renderer.toolEnd(ev.tool, ev.duration ?? 0, ev.error, ev.ctxDelta, ev.costUsd);
        }
      },
      (phase, info) => {
        if (phase === "thinking") {
          renderer.thinkingStart(info);
        } else {
          renderer.thinkingEnd();
        }
      },
      (reasoning) => renderer.reasoning(reasoning),
    );
  } catch (err) {
    // Throw из цикла агента не должен скипать shutdown/updater или дампить
    // голый стек: показываем как чистый error-результат.
    result = {
      success: false,
      text: "",
      error: errMsg(err),
      iterationCount: 0,
    };
  }
  renderer.flush();
  if (result.provider && result.model) {
    renderer.footer(
      result.model,
      result.provider,
      result.llmDurationMs ?? result.durationMs ?? 0,
    );
  }
  const exitCode = printRunResult(result, () => renderer.flush());
  agent.shutdown();
  await updater?.waitForIdle();
  process.exit(exitCode);
}
