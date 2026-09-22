import { createProgram } from "./commands";
import { bootstrap, setOneShotMode, applyReasoningCliOverride } from "../core/bootstrap";
import { Repl } from "./repl";
import { Renderer } from "../ui/renderer";
import { resolveVerbosity } from "../ui/theme";
import { printRunResult } from "./run-result";
import { runSetup } from "./setup";
import { applyAnswersToConfig } from "./setup-order";
import { relaunchCli } from "./relaunch";
import { defaultOutputBus, getDefaultChannel, JsonOutputSink, writeMachineJson } from "../output";
import { buildJsonError, buildJsonResult } from "./json-payload";
import { saveConfig, loadConfig } from "../config/config";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { UpdaterModule, isDevEntryPath } from "../modules/updater/index";
import { installCrashHandlers } from "../core/crash-handler";
import { readMmaVersion } from "../core/version";
import { closestCommand } from "./command-suggest";
import { errMsg } from "../utils";

/**
 * Set only for one-shot `--json` runs (a positional prompt exists). Module-scoped
 * so the top-level `main().catch` can still emit a valid document when `bootstrap`
 * (or anything before the JSON branch) throws with empty stdout. Interactive
 * `mma --json` (no prompt) must not set it, or a REPL crash would emit JSON.
 */
let jsonMode = false;

/** Fire-and-forget self-update in the background (never blocks startup). */
function startAutoUpdate(config: {
  updater: { enabled: boolean; checkOnStart: boolean; autoInstall: boolean; intervalMs: number };
}): UpdaterModule | undefined {
  // Dev runs load TypeScript sources; the published bundle runs dist/main.js.
  // Never auto-update from a checkout — its package.json version may trail npm
  // and global-installing over the user's install is destructive.
  if (isDevEntryPath(fileURLToPath(import.meta.url))) return undefined;
  try {
    const module = new UpdaterModule(config.updater, readMmaVersion(), "micro-models-agent", {
      info: (m) => defaultOutputBus.log("info", "updater", m),
      warn: (m) => defaultOutputBus.log("warn", "updater", m),
      error: (m) => defaultOutputBus.log("error", "updater", m),
    });
    module.start();
    return module;
  } catch {
    // Auto-update is best-effort; never let it crash startup.
    return undefined;
  }
}

async function main(): Promise<void> {
  // Install global crash handlers first — every crash lands in
  // ~/.mma/logs/crash.jsonl (with env report) instead of a bare stderr stack.
  installCrashHandlers();

  // Eagerly create the default channel so it subscribes to `defaultOutputBus`
  // BEFORE any config/bootstrap code can emit (config warnings, migration
  // summary, updater notices). The channel is created lazily by
  // `getDefaultChannel()`; without this call every bus event emitted before the
  // first channel use would have no terminal subscriber and be dropped.
  getDefaultChannel();

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
  if (firstPositional && program.commands.some((c) => c.name() === firstPositional)) {
    setOneShotMode(true);
  }

  program.parse(process.argv);

  const cmdNames = new Set(program.commands.map((c) => c.name()));
  const opts = program.opts();
  const noAgentsMd = opts.noAgentsMd === true;
  const projectDir = opts.dir;
  const exitOnComplete = opts.exitOnComplete === true;
  const jsonOpt = opts.json === true;
  const reasoningLevel = opts.reasoning as string | undefined;
  const verboseOpt = opts.verbose === true;
  const contextLog = opts.contextLog === true;

  // Quiet chat hides structured info logs; --verbose (or a verbose config)
  // brings them back. Set before bootstrap so its own logs respect it.
  getDefaultChannel().setSuppressInfoLogs(!verboseOpt);

  const isSubcommand = program.args.length > 0 && cmdNames.has(program.args[0]);

  if (isSubcommand) {
    return;
  }

  // Typo guard: a misspelled subcommand must not be silently sent to the LLM
  // as a prompt ("mma sesion list" → chat). Warn and exit when args[0] is a
  // near-miss of a known command; free-form prompts never look like that.
  if (program.args.length > 0) {
    const suggestion = closestCommand(program.args[0], [...cmdNames]);
    if (suggestion && suggestion !== program.args[0]) {
      getDefaultChannel().writeLine(
        pc.yellow(`${t("cli.unknown_command", { input: program.args[0], suggestion })}`),
        "stderr",
      );
      process.exit(2);
    }
  }

  if (program.args.length > 0) {
    // `--json` owns stdout for ONE-SHOT runs only: silence the human channel
    // before bootstrap so config warnings cannot pollute the machine-readable
    // document, and subscribe the sink BEFORE bootstrap so warn/error events
    // emitted during bootstrap are captured and surfaced as diagnostics.
    // Info-level migration notices are intentionally not captured (diagnostics
    // are warn/error only). A no-prompt invocation (`mma --json`) opens the
    // interactive REPL, so neither quiet nor the sink is set there.
    if (jsonOpt) {
      jsonMode = true;
      getDefaultChannel().setQuiet(true);
    }
    const jsonSink = jsonOpt ? new JsonOutputSink(defaultOutputBus) : undefined;

    const prompt = program.args.join(" ");
    const mmaDir = process.env.MMA_CONFIG_DIR || join(homedir(), ".mma");
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
    getDefaultChannel().setSuppressInfoLogs(
      !(verboseOpt || config.ui.verbose || config.ui.verbosity === "verbose"),
    );

    if (legacyDetected) {
      getDefaultChannel().writeLine(pc.yellow(`  ${t("config.legacy_hint")}`), "stderr");
    }

    if (virgin && !jsonOpt) {
      getDefaultChannel().writeLine(pc.yellow(`  ${t("cli.first_run_oneshot")}`), "stderr");
    }

    // Surface the loaded-vs-configured context mismatch in one-shot mode too
    // (previously only Repl.start() rendered it). Skipped under --json.
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
        // best-effort
      }
    }

    const updater = exitOnComplete ? undefined : startAutoUpdate(config);

    if (jsonMode) {
      let result;
      try {
        result = await agent.run(prompt);
      } catch (err) {
        // --json must never emit a raw stack trace: an AbortError or a
        // crashing tool/plugin still yields a valid machine-readable result,
        // and shutdown/waitForIdle still run.
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

    // TODO(output): one-shot runs don't surface the context-probe warning
    // (only Repl.start() renders it). Surface it here when bootstrap exposes
    // the probe result to this branch.
    const renderer = new Renderer({
      spinner: config.ui?.spinner ?? true,
      baseDir,
      verbosity: resolveVerbosity(config.ui),
    });
    renderer.showLoader();
    let result;
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
        (phase) => {
          if (phase === "thinking") {
            renderer.thinkingStart();
          } else {
            renderer.thinkingEnd();
          }
        },
      );
    } catch (err) {
      // A throw from the agent loop must not skip shutdown/updater or dump a
      // bare stack — surface it as a clean error result.
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
    const mmaDir = process.env.MMA_CONFIG_DIR || join(homedir(), ".mma");
    const legacyConfigPath = join(mmaDir, "config.json");
    let hasAnyConfig = existsSync(legacyConfigPath);
    if (!hasAnyConfig) {
      try {
        const { hasDomainFiles } = await import("../config/domains");
        hasAnyConfig = hasDomainFiles(mmaDir);
      } catch {}
    }

    const projectConfigPath = projectDir ? join(projectDir, ".mmrc") : join(process.cwd(), ".mmrc");

    // First run: collect settings, persist them, then RE-EXEC the CLI in a fresh
    // process and exit. The wizard and the REPL must not share a process: on
    // Bun/Windows the raw-mode LineEditor only receives keypresses when it is
    // the first consumer of stdin, and reusing one editor across
    // wizard → bootstrap → REPL leaks prompt/frame state. The relaunched
    // process sees the saved config, skips the wizard, and creates its editor
    // first thing. `MMA_POST_SETUP=1` guards against a re-run loop.
    if (!hasAnyConfig && !exitOnComplete && process.env.MMA_POST_SETUP !== "1") {
      getDefaultChannel().writeLine("\n  " + t("cli.first_run") + "\n");
      const answers = await runSetup();
      const { config } = loadConfig({ configDir: mmaDir, projectConfigPath });
      // Preserve the CLI --reasoning override (bootstrap in the fresh process
      // would apply it too, but persist it now so the child reads the final
      // config).
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
    getDefaultChannel().setSuppressInfoLogs(
      !(verboseOpt || config.ui.verbose || config.ui.verbosity === "verbose"),
    );

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
  // A throw before/during bootstrap would otherwise leave `--json` callers with
  // empty stdout; emit a valid failure document instead of a human stack.
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

export { main };
