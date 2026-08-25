import { createProgram } from "./commands";
import { bootstrap } from "../core/bootstrap";
import { Repl } from "./repl";
import { Renderer } from "../ui/renderer";
import { printRunResult } from "./run-result";
import { runSetup } from "./setup";
import { saveConfig, loadConfig } from "../config/config";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { UpdaterModule } from "../modules/updater/index";
import { installCrashHandlers } from "../core/crash-handler";
import { readMmaVersion } from "../core/version";

/** Fire-and-forget self-update in the background (never blocks startup). */
function startAutoUpdate(config: {
  updater: { enabled: boolean; checkOnStart: boolean; autoInstall: boolean; intervalMs: number };
}): UpdaterModule | undefined {
  try {
    const module = new UpdaterModule(config.updater, readMmaVersion(), "micro-models-agent", {
      info: (m) => process.stderr.write(pc.dim(m) + "\n"),
      warn: (m) => process.stderr.write(pc.yellow(m) + "\n"),
      error: (m) => process.stderr.write(pc.red(m) + "\n"),
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

  const program = createProgram();
  program.parse(process.argv);

  const cmdNames = new Set(program.commands.map((c) => c.name()));
  const opts = program.opts();
  const noAgentsMd = opts.noAgentsMd === true;
  const projectDir = opts.dir;
  const exitOnComplete = opts.exitOnComplete === true;
  const jsonMode = opts.json === true;
  const reasoningLevel = opts.reasoning as string | undefined;

  const isSubcommand = program.args.length > 0 && cmdNames.has(program.args[0]);

  if (isSubcommand) {
    return;
  }

  if (program.args.length > 0) {
    const prompt = program.args.join(" ");
    const { agent, config, baseDir, legacyDetected } = await bootstrap(undefined, projectDir, noAgentsMd, exitOnComplete, reasoningLevel);

    if (legacyDetected) {
      console.error(pc.yellow(`  ${t("config.legacy_hint")}`));
    }

    const updater = exitOnComplete ? undefined : startAutoUpdate(config);

    if (jsonMode) {
      const result = await agent.run(prompt);
      agent.shutdown();
      process.stdout.write(
        JSON.stringify(
          {
            success: result.success,
            text: result.text,
            error: result.error ?? null,
            iterationCount: result.iterationCount,
            contextUsed: result.contextUsed ?? null,
            contextLimit: result.contextLimit ?? null,
            promptTokens: result.promptTokens ?? null,
            completionTokens: result.completionTokens ?? null,
            totalTokens: result.totalTokens ?? null,
            totalCost: result.totalCost ?? null,
            costBreakdown: result.costBreakdown ?? [],
          },
          null,
          2,
        ),
      );
      process.stdout.write("\n");
      await updater?.waitForIdle();
      process.exit(result.success ? 0 : 1);
    }

    const renderer = new Renderer({
      spinner: config.ui?.spinner ?? true,
      toolStyle: config.ui?.toolStyle ?? "inline",
      baseDir,
    });
    const result = await agent.run(
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
    renderer.flush();
    const exitCode = printRunResult(result, () => renderer.flush());
    agent.shutdown();
    await updater?.waitForIdle();
    process.exit(exitCode);
  } else {
    const mmaDir = join(homedir(), ".mma");
    const legacyConfigPath = join(mmaDir, "config.json");
    let hasAnyConfig = existsSync(legacyConfigPath);
    if (!hasAnyConfig) {
      try {
        const { hasDomainFiles } = await import("../config/domains");
        hasAnyConfig = hasDomainFiles(mmaDir);
      } catch {}
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
    } = await bootstrap(undefined, projectDir, noAgentsMd, exitOnComplete);

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
    );

    if (!hasAnyConfig) {
      // First run: wizard via the REPL's LineEditor (avoids Bun stdin conflict
      // from creating a second readline on process.stdin).
      console.log(pc.yellow("\n  " + t("cli.first_run") + "\n"));
      const answers = await runSetup(repl.rl);
      config.provider.type = answers.provider;
      config.provider.baseUrl = answers.apiBase;
      config.provider.apiKey = answers.apiKey;
      config.model = answers.model;
      config.contextWindow = answers.contextWindow;
      config.maxToolIterations = answers.maxToolIterations;
      config.locale = answers.locale;
      if (config.security) {
        config.security.enabled = true;
        config.security.bash.enabled = true;
        config.security.bash.blockDangerousFlags =
          answers.securityFlagsBlock || config.security.bash.blockDangerousFlags;
        if (answers.securityBashBlock) {
          config.security.bash.blacklist = [
            ...new Set([
              ...config.security.bash.blacklist,
              "rm", "dd", "chmod", "wget", "curl", "scp", "ssh",
              "nc", "netcat", "sudo", "su", "kill", "pkill",
              "killall", "shutdown", "reboot",
            ]),
          ];
        }
        if (!answers.securityPathsDeny) {
          config.security.paths.denied = [];
        }
      }
      saveConfig(config, legacyConfigPath, dirname(legacyConfigPath));
      await agent.reconfigure(config);
    }

    startAutoUpdate(config);
    await repl.start();
  }
}

main();

export { main };
