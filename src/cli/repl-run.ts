/**
 * Прогон хода агента из REPL: стрим в рендерер, футер, бары контекста, возврат
 * промпта и завершение meet-режима.
 *
 * Вынесено из `repl.ts` (правило 6). Хост — узкий вид `Repl`: кадр ввода,
 * рендерер, счётчики и состояние прогона.
 */
import { pc } from "../ui/colors";
import { LineEditor, type LineInput } from "../ui/line-editor";
import { Renderer } from "../ui/renderer";
import { resolveVerbosity } from "../ui/theme";
import { divider } from "../ui/box";
import { t } from "../i18n/index";
import { renderContextBar, reportDlpRedactions, type ContextBarResult } from "./context-bar";
import { formatPlanChecklist, stepContextForTool } from "../ui/plan-view";
import { exitMeetMode } from "../modules/onboarding/mode";
import { inputPrompt, presentPrompt } from "./repl-prompt";
import type { ReplContext } from "./repl-commands";
import type { Agent } from "../core/agent";
import type { AppConfig } from "../config/types";
import type { Logger } from "../logger/app-logger";
import type { OutputChannel } from "../output";
import type { SessionLogger } from "../core/session-logger";
import type { SessionManager } from "../modules/session/manager";
import type { ExecutionModule } from "../modules/execution/module";

/** Поля `Repl`, нужные прогону хода. */
export interface ReplRunHost extends ReplContext {
  running: boolean;
  promptPresented: boolean;
  runHandledPrompt: boolean;
  inputLocked: boolean;
  agentRunning: boolean;
  activeRenderer: Renderer | null;
  lastCompactionShown: number;
  pendingClipboardImage: string | null;
  rl: LineInput;
  logger?: Logger;
  output: OutputChannel;
  slog: SessionLogger;
  execModule?: ExecutionModule;
  agent: Agent;
  config: AppConfig;
  sessionManager?: SessionManager;
}

/** Прогон хода агента: стрим в рендерер, футер, бары, возврат промпта. */
export async function runAgent(host: ReplRunHost, input: string): Promise<void> {
  if (host.agentRunning) return;
  host.agentRunning = true;
  try {
    if (host.pendingClipboardImage) {
      const contextManager = host.agent.contextManager;
      if (contextManager) {
        contextManager.addPendingImage({
          type: "image_url",
          image_url: { url: host.pendingClipboardImage },
        });
      }
      host.pendingClipboardImage = null;
    }

    host.logger?.logREPL("user", input);

    // Кадр промпта сейчас снимется; гасим синк до любого стримленного вывода,
    // чтобы ничего не пыталось рисовать поверх него.
    host.promptPresented = false;
    // Отдаём терминал каналу на время прогона: редактор перестаёт рисовать кадр
    // и игнорит клавиши, и стрим не портит строку ввода. suspendFrame() идёт до
    // reset(), который иначе нарисовал бы кадр лишь затем, чтобы стереть.
    if (host.rl instanceof LineEditor) {
      host.rl.suspendFrame();
      host.rl.setInputEnabled(false);
      host.rl.reset();
    }
    host.output.beginStreaming();
    // Разделитель + ярлык агента, сырьём (без trailing newline): следующий чанк
    // Renderer.text() добавляет свой ведущий "\n", и writeLine здесь вставил бы
    // пустую строку ("Agent:\n\n...").
    host.output.writeRaw(`\r${divider()}\n${pc.green(t("repl.agent"))}`);

    const renderer = new Renderer({
      spinner: host.config.ui?.spinner ?? true,
      baseDir: host.baseDir,
      channel: host.output,
      verbosity: resolveVerbosity(host.config.ui),
    });
    host.activeRenderer = renderer;
    renderer.showLoader();
    const result = await host.agent.run(
      input,
      (c) => renderer.text(c),
      (m) => renderer.meta(m),
      (ev) => {
        if (ev.type === "start") {
          renderer.toolStart(
            ev.tool,
            ev.args,
            stepContextForTool(host.execModule?.getActivePlan() ?? null, ev.tool, ev.args),
            ev.icon,
          );
        } else {
          renderer.toolEnd(ev.tool, ev.duration ?? 0, ev.error, ev.ctxDelta, ev.costUsd);
          if (ev.tool === "plan" || ev.tool === "todo" || ev.tool === "plan_step") {
            renderPlan(host, renderer);
          }
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
    renderer.flush();
    reportDlpRedactions(host.output, host.sessionManager);
    if (result.provider && result.model) {
      renderer.footer(
        result.model,
        result.provider,
        result.llmDurationMs ?? result.durationMs ?? 0,
      );
    }
    host.output.writeLine("");

    host.logger?.logREPL(
      result.success ? "assistant" : "system",
      result.text?.slice(0, 400) || result.error || "",
    );

    if (!result.success) {
      host.output.writeLine(pc.red(`${t("error.prefix")}${result.error}`), "stderr");
    }
    host.lastCompactionShown = renderContextBar({
      output: host.output,
      ui: host.config.ui,
      lastCompactionShown: host.lastCompactionShown,
      result: result satisfies ContextBarResult,
    });
    // Закрываем ход агента: разделитель перед следующим промптом визуально
    // разводит соседние сообщения юзера/агента.
    host.output.writeLine(`\n${divider()}`);
  } finally {
    host.agentRunning = false;
    host.activeRenderer = null;
    host.output.endStreaming();
    if (host.rl instanceof LineEditor) {
      host.rl.setInputEnabled(true);
      // Единственный показ промпта на пути агента: resumeFrame() перерисовывает
      // кадр, так что слушатель `line` после runAgent() промпт НЕ показывает
      // (после slash-команд — показывает). Промпт переставляем первым, чтобы
      // уровень reasoning, сменённый set_thinking в прогоне, отразился на
      // возобновлённом кадре.
      host.rl.setPrompt(inputPrompt(host));
      host.rl.resumeFrame();
      host.promptPresented = true;
    } else {
      // У пайпнутого/не-TTY фолбэка кадра для resume нет; показываем readline-
      // промпт здесь ради старого пост-прогонного поведения.
      presentPrompt(host);
    }
    const onboardingCtx = host.agent.tryToolContext();
    if (onboardingCtx?.onboarding?.done) {
      exitMeetMode(host);
      host.slog.logOnboarding("meet_done", { model: host.config.model });
      host.output.writeLine(pc.dim(t("repl.meet_done")));
    }
    host.runHandledPrompt = true;
  }
}

/** Печать чеклиста плана, трекаемого ExecutionModule.
 *  Зовётся только на plan/todo-событиях (событие изменения), не поллится:
 *  дисковый план прошлой сессии не протечёт в чат. */
export function renderPlan(host: ReplRunHost, renderer: Renderer): void {
  const plan = host.execModule?.getActivePlan();
  if (!plan) return;
  renderer.planBlock(formatPlanChecklist(plan));
}
