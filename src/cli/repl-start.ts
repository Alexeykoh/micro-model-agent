/**
 * Старт REPL: гейт non-TTY онбординга, баннер, первый промпт, запуск
 * знакомства/инициализации и фоновых пробников (LSP, провайдеры, контекст).
 *
 * Вынесено из `repl.ts` (правило 6). Порядок шагов сохранён: баннер печатается
 * plain до первого кадра промпта.
 */
import { pc } from "../ui/colors";
import { t } from "../i18n/index";
import { readEnv, MMA_ENV } from "../config/env";
import { setExitCode } from "./exit-code";
import { DEFAULT_LSP_CONFIG } from "../modules/lsp/config";
import { probeProviders, targetsFromProviders } from "../modules/providers/health";
import { formatWarning } from "../ui/md-formatter";
import {
  contextProbeLine,
  printBanner,
  printLegacyConfigHint,
  probeLspBanner,
  writeBannerLine,
} from "./repl-banner";
import { restoreStartupPrompt } from "./repl-prompt";
import type { ReplContext } from "./repl-commands";
import type { ContextProbeResult } from "../llm/model-loader";
import type { LineInput } from "../ui/line-editor";
import type { Logger } from "../logger/app-logger";
import type { SessionLogger } from "../core/session-logger";
import type { OutputChannel } from "../output";

/** Поля `Repl`, нужные старту. */
export interface ReplStartHost extends ReplContext {
  running: boolean;
  promptPresented: boolean;
  runHandledPrompt: boolean;
  inputLocked: boolean;
  agentRunning: boolean;
  rl: LineInput;
  noAgentsMd: boolean;
  logger?: Logger;
  slog: SessionLogger;
  envReport?: import("../core/environment").EnvironmentReport;
  contextProbe?: Promise<ContextProbeResult | null>;
  output: OutputChannel;
}

export async function start(host: ReplStartHost): Promise<void> {
  host.running = true;

  // Интерактивный онбординг без TTY бесполезен, а раньше он гонялся со
  // stdin-EOF: REPL успевал выйти до печати причины, и код возврата зависел
  // от гонки. Выходим сразу и детерминированно (A-16).
  if (
    process.stdout.isTTY !== true &&
    (readEnv("START_MEET") === "1" || readEnv("START_INIT") === "1")
  ) {
    host.output.writeLine(pc.yellow(t("onboarding.non_interactive")), "stderr");
    process.exit(1);
  }

  printBanner(host);
  await printLegacyConfigHint(host);

  // Единственный показ промпта на старте: баннер выше печатался plain
  // (promptPresented был false), так что стирать кадр здесь нечего.
  host.rl.prompt();
  host.promptPresented = true;

  try {
    if (readEnv("START_MEET") === "1" || readEnv("START_INIT") === "1") {
      const mode = readEnv("START_MEET") === "1" ? "meet" : "init";
      delete process.env[MMA_ENV.START_MEET];
      delete process.env[MMA_ENV.START_INIT];
      host.slog.logOnboarding(`${mode}_start`, { model: host.config.model });
      if (mode === "meet") {
        const { runMeet } = await import("../modules/onboarding/meet");
        const started = await runMeet(host);
        // Отказ в non-TTY — не успех: процесс обязан вернуть ненулевой код,
        // иначе скрипт/CI считает, что знакомство записано (A-16).
        if (!started && process.stdout.isTTY !== true) setExitCode(1);
      } else {
        const { runInit } = await import("../modules/onboarding/init");
        const started = await runInit(host);
        if (!started && process.stdout.isTTY !== true) setExitCode(1);
        host.slog.logOnboarding("init_done", { model: host.config.model });
      }
    } else if (readEnv("POST_SETUP") === "1" && process.stdout.isTTY === true) {
      const { preflightFromConfig } = await import("../modules/providers/preflight");
      const pre = await preflightFromConfig(host);
      if (pre.ok) {
        host.output.writeLine(pc.dim(`${t("repl.meet_offer")} ${t("repl.meet_offer_hint")}`));
        const answer = (
          await new Promise<string>((resolve) => host.rl.question("[Y/n] ", resolve))
        )
          .trim()
          .toLowerCase();
        const yes =
          answer === "" || answer === "y" || answer === "yes" || answer === "да" || answer === "д";
        if (yes) {
          host.slog.logOnboarding("meet_start", { model: host.config.model });
          const { runMeet } = await import("../modules/onboarding/meet");
          await runMeet(host, { preflight: async () => pre });
        } else {
          restoreStartupPrompt(host);
        }
      } else {
        host.output.writeLine(pc.yellow(t("onboarding.provider_down", { cmd: "meet" })));
        host.output.writeLine(t("onboarding.provider_down_hint", { cmd: "meet" }));
      }
    }
  } catch (err) {
    host.logger?.debug(`Onboarding startup skipped: ${String(err)}`);
    restoreStartupPrompt(host);
  }

  // Статус LSP пробнится фоном — баннер блокировать нельзя.
  const isTty = process.stdout.isTTY === true;
  const lspEnabled = isTty && (host.config.lsp ?? DEFAULT_LSP_CONFIG).enabled !== false;

  if (lspEnabled) {
    probeLspBanner(host)
      .then((lspSummary) => {
        if (lspSummary) {
          const line = `${pc.green(t("repl.agent"))}${pc.yellow(t("repl.lsp_label"))} ${lspSummary}`;
          // Строкой промпта владеет канал: ручной erase + prompt()-хак не нужен.
          writeBannerLine(host, line);
        }
      })
      .catch(() => {});
  }

  if ((host.config.provider.entries?.length ?? 0) > 1) {
    // Phase 4.4: фоновый health-пробник всех entries (бесплатные listModels).
    // Упавшие провайдеры — предупреждениями: фейловер (Phase 4.2) молча
    // замаскировал бы мёртвый primary.
    void probeProviders(
      targetsFromProviders(
        (host.config.provider.entries ?? [])
          .map((e) => ({
            name: e.label || e.type,
            provider: host.agent.getProviderFor(e.label || e.type),
          }))
          .filter((x): x is { name: string; provider: NonNullable<typeof x.provider> } =>
            Boolean(x.provider),
          ),
      ),
      { timeoutMs: 5000 },
    )
      .then((results) => {
        for (const r of results) {
          if (!r.ok && r.name !== host.config.provider.active) {
            host.output.writeLine(
              formatWarning(t("repl.provider_down", { name: r.name, error: r.error ?? "" })),
            );
          }
        }
      })
      .catch(() => {});
  }

  // Контекст-пробник (фоном): сверяем контекст, с которым модель реально
  // загружена, против настроенного окна. Тот же неблокирующий баннер-паттерн,
  // что у LSP-пробника выше.
  if (host.contextProbe) {
    void host.contextProbe
      .then((probe) => {
        // Запись пробника персистит bootstrap (все режимы); здесь только строка баннера.
        const line = contextProbeLine(host, probe);
        if (line) {
          // Строкой промпта владеет канал: ручной erase + prompt()-хак не нужен.
          writeBannerLine(host, line);
        }
      })
      .catch(() => {});
  }
}
