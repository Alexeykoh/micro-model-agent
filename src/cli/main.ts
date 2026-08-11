import { createProgram } from "./commands";
import { bootstrap } from "../core/bootstrap";
import { Repl } from "./repl";
import { formatMarkdown } from "../ui/md-formatter";
import { Renderer } from "../ui/renderer";
import { runSetup } from "./setup";
import { saveConfig, loadConfig } from "../config/config";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

async function main(): Promise<void> {
  const program = createProgram();
  program.parse(process.argv);

  const cmdNames = new Set(program.commands.map((c) => c.name()));
  const opts = program.opts();
  const noAgentsMd = opts.noAgentsMd === true;
  const projectDir = opts.dir;
  const exitOnComplete = opts.exitOnComplete === true;
  const jsonMode = opts.json === true;

  const isSubcommand = program.args.length > 0 && cmdNames.has(program.args[0]);

  if (isSubcommand) {
    return;
  }

  if (program.args.length > 0) {
    const prompt = program.args.join(" ");
    const { agent, config } = await bootstrap(
      undefined,
      projectDir,
      noAgentsMd,
      exitOnComplete,
    );

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
          },
          null,
          2,
        ),
      );
      process.stdout.write("\n");
      process.exit(result.success ? 0 : 1);
    }

    const renderer = new Renderer({
      spinner: config.ui?.spinner ?? true,
      toolStyle: config.ui?.toolStyle ?? "inline",
    });
    const result = await agent.run(
      prompt,
      (chunk) => renderer.text(chunk),
      (meta) => renderer.meta(meta),
      (ev) => {
        if (ev.type === "start") {
          renderer.toolStart(ev.tool, ev.args);
        } else {
          renderer.toolEnd(ev.tool, ev.duration ?? 0, ev.error, ev.ctxDelta);
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
    if (result.success) {
      if (!result.text) {
        console.log(pc.yellow(t("cli.no_output")));
      }
    } else {
      console.error(`${t("error.prefix")}${result.error}`);
      if (result.text) {
        console.log(formatMarkdown(result.text));
      }
      process.exit(1);
    }
    agent.shutdown();
  } else {
    const configPath = join(homedir(), ".mma", "config.json");
    if (!existsSync(configPath)) {
      console.log(pc.yellow("\n  " + t("cli.first_run") + "\n"));
      const answers = await runSetup();
      const config = loadConfig({
        configDir: join(homedir(), ".mma"),
        projectConfigPath: projectDir
          ? join(projectDir, ".mmrc")
          : join(process.cwd(), ".mmrc"),
      });
      config.provider.type = answers.provider;
      config.provider.baseUrl = answers.apiBase;
      config.provider.apiKey = answers.apiKey;
      config.model = answers.model;
      config.contextWindow = answers.contextWindow;
      config.maxToolIterations = answers.maxToolIterations;
      config.locale = answers.locale;
      if (config.security) {
        config.security.enabled =
          answers.securityBashBlock ||
          answers.securityFlagsBlock ||
          !answers.securityPathsDeny;
        config.security.bash.enabled = config.security.enabled;
        config.security.bash.blockDangerousFlags = answers.securityFlagsBlock;
        if (answers.securityBashBlock) {
          config.security.bash.blacklist = [
            ...new Set([
              ...config.security.bash.blacklist,
              "rm",
              "dd",
              "chmod",
              "wget",
              "curl",
              "scp",
              "ssh",
              "nc",
              "netcat",
              "sudo",
              "su",
              "kill",
              "pkill",
              "killall",
              "shutdown",
              "reboot",
            ]),
          ];
        }
        if (!answers.securityPathsDeny) {
          config.security.paths.denied = [];
        }
      }
      saveConfig(config, configPath);
    }
    const {
      agent,
      config,
      sessionManager,
      skillsModule,
      pluginManager,
      configDir,
      baseDir,
      logger,
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
    );
    repl.start();
  }
}

main();

export { main };
