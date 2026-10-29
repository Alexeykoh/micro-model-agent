// Точка входа CLI: parse, one-shot/REPL/web-ветки, JSON-режим, автоапдейт.
import { createProgram } from "./commands";
import { bootstrap, setOneShotMode, setSessionAutocreate, applyReasoningCliOverride } from "../core/bootstrap";
import { Repl } from "./repl";
import { Renderer } from "../ui/renderer";
import { resolveVerbosity } from "../ui/theme";
import { printRunResult } from "./run-result";
import { runSetup } from "./setup";
import { runWeb, parsePort } from "./web-command";
import { runServe, parseServePort } from "./service-command";
import { applyAnswersToConfig } from "./setup-order";
import { relaunchCli } from "./relaunch";
import { defaultOutputBus, getDefaultChannel, JsonOutputSink, writeMachineJson } from "../output";
import { buildJsonError, buildJsonResult } from "./json-payload";
import { saveConfig, loadConfig } from "../config/config";
import { t, setLocale } from "../i18n/index";
import { pc } from "../ui/colors";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { type UpdaterModule, createUpdater, busLogger } from "../modules/updater/index";
import { installCrashHandlers } from "../core/crash-handler";
import { closestCommand } from "./command-suggest";
import { errMsg } from "../utils";
import type { AgentResult } from "../core/types";
import { globalMmaDir } from "../config/paths";
import { MMA_ENV, readEnv } from "../config/env";

/**
 * Взведён только для one-shot `--json`-прогонов (позиционный промпт есть). На уровне
 * модуля, чтобы топ-уровневый `main().catch` отдал валидный документ, даже когда
 * `bootstrap` (или что-то до JSON-ветки) бросил с пустым stdout. Интерактивный
 * `mma --json` (без промпта) его не ставит, иначе краш REPL эмитил бы JSON.
 */
let jsonMode = false;

/**
 * Резолвит UI-локаль ДО `createProgram()`: описания команд и подсказка-тайпоупор
 * строятся через `t()` в момент регистрации, так что установка локали только в
 * bootstrap оставляла `--help` и near-miss хинты английскими при `locale: ru`.
 * Дешёвое защитное чтение файла, не полный лоад конфига.
 */
function resolveEarlyLocale(): string | undefined {
  const env = readEnv("LOCALE");
  if (env) return env;
  const dir = globalMmaDir();
  for (const p of [join(dir, "config", "core.json"), join(dir, "config.json")]) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as { locale?: unknown };
      if (typeof parsed.locale === "string") return parsed.locale;
    } catch {
      /* missing/invalid file — try the next candidate */
    }
  }
  return undefined;
}

/** Fire-and-forget самоапдейт фоном (старт никогда не блокирует). */
function startAutoUpdate(config: {
  updater: { enabled: boolean; autoInstall: boolean; intervalMs: number };
}): UpdaterModule | undefined {
  return createUpdater({
    config: config.updater,
    entryPath: fileURLToPath(import.meta.url),
    logger: busLogger(),
  });
}

async function main(): Promise<void> {
  // Глобальные краш-хендлеры первым делом: каждый краш ложится в
  // ~/.mma/logs/crash.jsonl (с env-репортом), а не голым стеком в stderr.
  installCrashHandlers();

  // Канал-дефолт создаём жадно, чтобы подписался на `defaultOutputBus` ДО того, как
  // конфиг/bootstrap что-то эмитит (варнинги конфига, сводка миграции, апдейтер).
  // Канал ленив через `getDefaultChannel()`: без этого вызова каждое событие шины
  // до первого использования канала осталось бы без терминального подписчика и дропнулось.
  getDefaultChannel();

  setLocale(resolveEarlyLocale() ?? "en");

  const program = createProgram();

  // Определяем подкоманду ДО parse: commander запускает async-action синхронно
  // из parse(), поэтому флаг one-shot нужно выставить заранее, иначе bootstrap
  // успеет стартовать фоновый startup health check (ребёнок переживает
  // process.exit и на Windows держит stdout-пайп — команда «виснет»).
  const valueOpts = new Set(["-d", "--dir", "--reasoning"]);
  const argv = process.argv.slice(2);
  let firstPositional: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("-")) {
      if (valueOpts.has(a)) i++;
      continue;
    }
    firstPositional = a;
    break;
  }
  const onboardingStart =
    firstPositional === "meet" ? "meet" : firstPositional === "agents" ? "init" : null;
  // One-shot для ЛЮБОГО первого позиционного аргумента, который не является
  // подкомандой: свободный промпт тоже не должен поднимать фоновых детей
  // (аудит §7.10).
  if (firstPositional && !onboardingStart) {
    setOneShotMode(true);
  }

  // A-01: read-only команды не должны создавать сессию. Команды, которым нужен
  // агент/диалог, перечислены явно; всё остальное (plugins/model/config/session/
  // map/doctor/security …) работает без новой сессии.
  const commandNames = new Set(program.commands.map((c) => c.name()));
  const SESSION_COMMANDS = new Set(["web", "serve", "meet", "agents"]);
  const knownCommand = firstPositional ? commandNames.has(firstPositional) : false;
  setSessionAutocreate(!knownCommand || SESSION_COMMANDS.has(firstPositional!));

  program.parse(process.argv);

  const cmdNames = commandNames;
  const opts = program.opts();
  // commander превращает `--no-agents-md` в отрицаемый `agentsMd`-bool
  // (дефолт true); ключа `noAgentsMd` нет.
  const noAgentsMd = opts.agentsMd === false;
  const projectDir = opts.dir;
  const exitOnComplete = opts.exitOnComplete === true;
  const jsonOpt = opts.json === true;
  const reasoningLevel = opts.reasoning as string | undefined;
  const verboseOpt = opts.verbose === true;
  const contextLog = opts.contextLog === true;

  // Quiet-чат прячет структурные info-логи; --verbose (или verbose-конфиг) их
  // возвращает. Ставим до bootstrap, чтобы его собственные логи уважали флаг.
  // Диагностика петли (`Logger.diagnostic`) следует тому же правилу видимости.
  const applyLogVisibility = (verbose: boolean): void => {
    getDefaultChannel().setSuppressInfoLogs(!verbose);
    getDefaultChannel().setShowDiagnostics(verbose);
  };
  applyLogVisibility(verboseOpt);

  // `web` долгоживущий: его action — no-op, сервер стартует здесь, после parse,
  // чтобы пережить one-shot exit-хук (на `web` в commands.ts он осознанно не вешается).
  if (program.args[0] === "web") {
    const webOpts = (program.commands.find((c) => c.name() === "web")?.opts() ?? {}) as {
      port?: string;
      host?: string;
      token?: string;
      open?: boolean;
    };
    let port: number | undefined;
    try {
      port = parsePort(webOpts.port);
    } catch (err) {
      getDefaultChannel().writeLine(pc.red(`  ${errMsg(err)}`), "stderr");
      process.exit(2);
    }
    await runWeb({
      port,
      host: webOpts.host,
      token: webOpts.token,
      noOpen: webOpts.open === false,
      projectDir,
      noAgentsMd,
    });
    process.exit(0);
  }

  // `serve` долгоживущий: стартует здесь, после parse, вне one-shot exit-хука.
  if (program.args[0] === "serve") {
    const serveOpts = (program.commands.find((c) => c.name() === "serve")?.opts() ?? {}) as {
      port?: string;
      host?: string;
      token?: string;
    };
    let port: number | undefined;
    try {
      port = parseServePort(serveOpts.port);
    } catch (err) {
      getDefaultChannel().writeLine(pc.red(`  ${errMsg(err)}`), "stderr");
      process.exit(2);
    }
    await runServe({
      port,
      host: serveOpts.host,
      token: serveOpts.token,
      projectDir,
      noAgentsMd,
    });
    process.exit(0);
  }

  const isSubcommand =
    program.args.length > 0 && cmdNames.has(program.args[0]) && !onboardingStart;

  if (isSubcommand) {
    return;
  }

  // Тайпо-сторож: субкоманда с опечаткой не должна молча уходить в LLM как
  // промпт ("mma sesion list" → чат). На near-miss известной команды — warn и выход;
  // свободные промпты так не выглядят никогда.
  if (program.args.length > 0 && !onboardingStart) {
    const suggestion = closestCommand(program.args[0], [...cmdNames]);
    if (suggestion && suggestion !== program.args[0]) {
      getDefaultChannel().writeLine(
        pc.yellow(`${t("cli.unknown_command", { input: program.args[0], suggestion })}`),
        "stderr",
      );
      process.exit(2);
    }
  }

  if (program.args.length > 0 && !onboardingStart) {
    // `--json` владеет stdout ТОЛЬКО в one-shot: гасим человеческий канал до
    // bootstrap, чтобы варнинги конфига не запачкали машиночитаемый документ,
    // и подписываем sink ДО bootstrap, чтобы warn/error bootstrap попали в
    // captured-диагностику. Info-нотисы миграции осознанно не каптурятся
    // (диагностика — только warn/error). Вызов без промпта (`mma --json`)
    // открывает интерактивный REPL: ни quiet, ни sink там не ставятся.
    if (jsonOpt) {
      jsonMode = true;
      getDefaultChannel().setQuiet(true);
    }
    const jsonSink = jsonOpt ? new JsonOutputSink(defaultOutputBus) : undefined;

    const prompt = program.args.join(" ");
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
    if (verboseOpt) config.ui.verbosity = "verbose";
    applyLogVisibility(verboseOpt || config.ui.verbose || config.ui.verbosity === "verbose");

    if (legacyDetected) {
      getDefaultChannel().writeLine(pc.yellow(`  ${t("config.legacy_hint")}`), "stderr");
    }

    if (virgin && !jsonOpt) {
      getDefaultChannel().writeLine(pc.yellow(`  ${t("cli.first_run_oneshot")}`), "stderr");
    }

    // Расхождение загруженного и настроенного контекста показываем и в one-shot
    // (раньше только Repl.start() рендерил). Под --json скипаем.
    if (contextProbe && !jsonOpt) {
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
  } else {
    if (onboardingStart === "meet") process.env[MMA_ENV.START_MEET] = "1";
    if (onboardingStart === "init") process.env[MMA_ENV.START_INIT] = "1";
    const mmaDir = globalMmaDir();
    const legacyConfigPath = join(mmaDir, "config.json");
    let hasAnyConfig = existsSync(legacyConfigPath);
    if (!hasAnyConfig) {
      try {
        const { hasDomainFiles } = await import("../config/domains");
        hasAnyConfig = hasDomainFiles(mmaDir);
      } catch {
        // Пробник доменов best-effort: отсутствующий/битый модуль не блокирует
        // CLI. Фолбэк — проверка legacy config.json выше.
      }
    }

    const projectConfigPath = projectDir ? join(projectDir, ".mmrc") : join(process.cwd(), ".mmrc");

    // Первый запуск: собираем настройки, персистим, затем ПЕРЕИСПОЛНЯЕМ CLI в свежем
    // процессе и выходим. Визард и REPL не делят процесс: на Bun/Windows raw-режимный
    // LineEditor получает keypress, только будучи первым потребителем stdin, а
    // переиспользование одного редактора через wizard → bootstrap → REPL протекает
    // состоянием промпта/кадра. Перезапущенный процесс видит сохранённый конфиг,
    // скипает визард и создаёт редактор первым делом. `MMA_POST_SETUP=1` сторожит
    // от петли перезапуска.
    if (!hasAnyConfig && !exitOnComplete && readEnv("POST_SETUP") !== "1") {
      getDefaultChannel().writeLine(`\n  ${t("cli.first_run")}\n`);
      const answers = await runSetup();
      const { config } = loadConfig({ configDir: mmaDir, projectConfigPath });
      // Сохраняем CLI-оверрайд --reasoning (bootstrap в свежем процессе применил бы
      // его тоже, но персистим сейчас, чтобы ребёнок прочитал финальный конфиг).
      applyReasoningCliOverride(config, reasoningLevel);
      applyAnswersToConfig(config, answers);
      saveConfig(config, legacyConfigPath, dirname(legacyConfigPath));
      getDefaultChannel().writeLine(pc.dim(`  ${t("cli.setup_saved_restart")}`));
      relaunchCli();
    }

    const {
      agent,
      config,
      sessionManager,
      skillsModule,
      pluginManager,
      execModule,
      configDir,
      baseDir,
      logger,
      envReport,
      contextProbe,
    } = await bootstrap(undefined, projectDir, noAgentsMd, exitOnComplete, reasoningLevel, contextLog);
    if (verboseOpt) config.ui.verbosity = "verbose";
    applyLogVisibility(verboseOpt || config.ui.verbose || config.ui.verbosity === "verbose");

    const repl = new Repl(
      agent,
      config,
      sessionManager,
      skillsModule,
      pluginManager,
      configDir,
      baseDir,
      noAgentsMd,
      logger,
      true,
      envReport,
      undefined,
      execModule,
      contextProbe,
    );

    startAutoUpdate(config);
    await repl.start();
  }
}

main().catch((err) => {
  // Throw до/во время bootstrap иначе оставил бы `--json`-вызывающих с пустым
  // stdout; эмитим валидный failure-документ вместо человеческого стека.
  if (jsonMode) {
    writeMachineJson(buildJsonError(errMsg(err)));
  } else {
    getDefaultChannel().writeLine(
      err instanceof Error ? (err.stack ?? err.message) : String(err),
      "stderr",
    );
  }
  process.exit(1);
});

/** Точка входа CLI (диспатч веток + топ-уровневый catch для `--json`). */
export { main };
