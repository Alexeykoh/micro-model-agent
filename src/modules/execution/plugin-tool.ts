// Туловые хуки execution-плагина (вынесено из `execution-plugin.ts`,
// правило 6): план-варнинги, журнал вызовов для stuck-детектора, пофайловый
// typecheck, bash-фейлы, автопродвижение и автопоиск ошибки. Логика перенесена
// дословно.
import type { ToolCall } from "../../tools/types";
import { t } from "../../i18n/index";
import { detectTestResults } from "../../tools/bash";
import { forbiddenWindowsCommand } from "./windows-commands";
import { platform } from "os";
import {
  FS_MUTATING_TOOLS,
  MAX_PLAN_WARNINGS_BEFORE_BLOCK,
  type ExecutionPluginDeps,
} from "./plugin-state";
import { autoMarkDeletedStep, recordPlanMutation, recordTypecheckOutcome } from "./plugin-plan";

export function runBeforeTool(deps: ExecutionPluginDeps, call: ToolCall): true | string {
  const warning = deps.checkPlanAlignment(call);
  if (warning) {
    deps.pendingMessages.push({
      role: "user",
      content: `<system-summary>${warning}</system-summary>`,
    });
    deps.state.consecutivePlanWarnings++;
    if (deps.state.consecutivePlanWarnings >= MAX_PLAN_WARNINGS_BEFORE_BLOCK) {
      deps.pendingMessages.push({
        role: "user",
        content: `<system-summary>${t("exec.plan_blocked", { step: String(deps.trackerRef.current?.getCurrentStep()?.id ?? "?"), max: MAX_PLAN_WARNINGS_BEFORE_BLOCK })}</system-summary>`,
      });
      // Блок с явной причиной, чтобы модель видела, ПОЧЕМУ вызов
      // заблокирован (executor показывает через tool.blocked_reason).
      return t("exec.plan_blocked", {
        step: String(deps.trackerRef.current?.getCurrentStep()?.id ?? "?"),
        max: MAX_PLAN_WARNINGS_BEFORE_BLOCK,
      });
    }
  } else {
    deps.state.consecutivePlanWarnings = 0;
  }
  return true;
}

export function runToolCall(deps: ExecutionPluginDeps, ctx: any): void {
  const toolName = ctx?.toolName as string;
  const args = ctx?.args as Record<string, unknown>;
  if (toolName && args) {
    deps.stuckDetector.recordToolCall(toolName, args);
    recordPlanMutation(deps, toolName, args);
  }
}

export function runAfterTool(deps: ExecutionPluginDeps, ctx: any, call: any, result: any): void {
  // Файловая мутация хода → финальному аудиту есть что ломать тестами.
  // bash/browser/mcp считаются консервативно: успех мог писать на диск.
  if (result.success && FS_MUTATING_TOOLS.has(call.name)) deps.state.mutatedThisTurn = true;
  // Запоминаем каждый вызов bash (успех или нет): детекция рассуждает,
  // напр., о повторных прогонах с пустым выводом.
  if (call.name === "bash") {
    deps.stuckDetector.recordBashOutput(
      String(call.arguments?.command ?? ""),
      String(result.output ?? ""),
    );
  }
  autoMarkDeletedStep(deps, call, result);
  // write/edit/bash с успехом, но type/syntax-ошибкой в выводе — НЕ успех:
  // модель чинит реальную ошибку, а не переписывает файл вслепую. Кормим
  // stuck-детектор, чтобы сработал хинт rewrite-петли.
  const toolText = String(result.output ?? "");
  const hasTypeError = /error TS\d+|\[Project typecheck failed\]|\[Syntax check failed\]/.test(
    toolText,
  );
  if (hasTypeError) {
    deps.stuckDetector.recordToolError(call.name, toolText.slice(0, 300));
  }
  recordTypecheckOutcome(deps, call, result, toolText);
  if (!result.success) {
    // Исход bash-попытки кормим во флейлинг-окно ДО пер-командной обработки —
    // ротация разных фейлящихся команд (wc → cat → Get-Content → …) обязана
    // триггерить детектор.
    if (call.name === "bash") {
      deps.stuckDetector.recordBashAttempt(false);
    }
    // Hard stop для запрещённых Windows-команд: после второго фейла той же
    // запрещённой команды (grep/sed/ls/find/…) инжектим STOP, чтобы сессия
    // не жгла bash-вызовы на командах без cmd.exe. Зеркалит собственный
    // win32-gated hard-stop тула bash (src/tools/bash.ts) — на macOS/Linux
    // эти команды есть и фейлятся по легитимным причинам.
    if (call.name === "bash" && platform() === "win32") {
      const cmd = String(call.arguments?.command ?? "");
      const forbidden = forbiddenWindowsCommand(cmd);
      if (forbidden) {
        const n = (deps.forbiddenBashFailures.get(forbidden) || 0) + 1;
        deps.forbiddenBashFailures.set(forbidden, n);
        if (n === 2) {
          deps.pendingMessages.push({
            role: "user",
            content: `<system-summary>${t("exec.forbidden_cmd", { cmd: forbidden })}</system-summary>`,
          });
        }
      }
    }
    // Type/syntax-ошибка в иначе "успешном" результате уже записана выше.
    // Фейлящийся вызов (result.success === false) иначе посчитал бы ту же
    // ошибку дважды (typecheck-ветка + failure-ветка), раздув счётчик
    // error-сигнатур и триггернув веб-поиск на половине порога.
    if (!hasTypeError) {
      deps.stuckDetector.recordToolError(call.name, result.output);
    }
  } else {
    // "Успешная" запись/правка может нести type/syntax-ошибку (lint-on-write
    // хук аппендит её, оставляя success:true). Скормленный здесь
    // recordToolSuccess() отменял recordToolError выше на том же вызове —
    // rewrite-loop сигнал не накапливался.
    if (!hasTypeError) deps.stuckDetector.recordToolSuccess(call.name);
    if (call.name === "bash") {
      deps.stuckDetector.recordBashAttempt(true);
    }

    // Успешно отработавшая команда bash с кодом — предлагаем маркить шаг
    // done, если только вывод не показывает упавшие тесты (их нельзя
    // репортить чистым успехом).
    if (call.name === "bash" && result.success) {
      const cmd = String(call.arguments?.command ?? "");
      const testRun = detectTestResults(String(result.output ?? ""));
      if (testRun && testRun.failed > 0) {
        deps.pendingMessages.push({
          role: "user",
          content: `<system-summary>${t("exec.test_fail_summary", {
            framework: testRun.framework,
            failed: String(testRun.failed),
            passed: String(testRun.passed),
          })}</system-summary>`,
        });
      } else if (testRun && testRun.failed === 0 && testRun.passed > 0) {
        deps.pendingMessages.push({
          role: "user",
          content: `<system-summary>${t("exec.test_pass_summary", {
            framework: testRun.framework,
            passed: String(testRun.passed),
            cmd,
          })}</system-summary>`,
        });
      }
    }
  }

  if (result.success && (call.name === "write_file" || call.name === "edit_file")) {
    const filePath = call.arguments?.path as string;
    if (filePath) {
      deps.stuckDetector.recordFileRewrite(filePath);
      if (deps.stuckDetector.hasExcessiveRewrites()) {
        const file = deps.stuckDetector.getExcessiveRewriteFile();
        const count = deps.stuckDetector.getFileRewriteCount(file!);
        if (ctx.onMeta) {
          ctx.onMeta(
            t("exec.file_rewrite_warning", {
              file: file!,
              count: String(count),
            }),
          );
        }
      }
    }
  }

  // Автопродвижение срабатывает после каждого успешного ФС-МУТИРУЮЩЕГО
  // тула, не только write_file/edit_file. Мелкие модели часто создают файлы
  // через bash (`echo ... > f`, heredoc'и) или delete/move через shell
  // вместо выделенных тулов — план тогда не двигается с шага, хотя
  // deliverables на диске (сертификация 3.5/3.8: файлы на месте, план
  // висит на 1/4 и 4/5). Read-only тулы исключены: успешный read/glob иначе
  // закрыл бы шаг "Update X", чей файл существует с раннего шага, — без
  // единой правки. advancePlanIfStepComplete — no-op, если токены не резолвятся.
  if (result.success && FS_MUTATING_TOOLS.has(call.name)) {
    deps.advancePlanIfStepComplete(ctx.sessionLog);
  }

  // Автопоиск в вебе повторяющейся ошибки (fire-and-forget, результаты
  // падают в pendingMessages на следующем флаше onBeforeThink).
  deps.maybeSearchError(ctx, call);
}
