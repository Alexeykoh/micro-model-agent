import { createProgram } from "./commands";
import { bootstrap } from "../core/bootstrap";
import { Repl } from "./repl";
import { formatMarkdown } from "../ui/md-formatter";
import { runSetup } from "./setup";
import { saveConfig } from "../config/config";
import { t } from "../i18n/index";
import pc from "picocolors";
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

  const isSubcommand = program.args.length > 0 && cmdNames.has(program.args[0]);

  if (isSubcommand) {
    return;
  }

  if (program.args.length > 0) {
    const prompt = program.args.join(" ");
    const { agent } = await bootstrap(undefined, projectDir, noAgentsMd, exitOnComplete);
    const chunks: string[] = [];
    const result = await agent.run(
      prompt,
      (chunk) => {
        chunks.push(chunk);
        process.stdout.write(chunk);
      },
      (meta) => process.stdout.write(meta),
    );
    if (result.success) {
      if (!result.text && chunks.length === 0) {
        console.log(pc.yellow(t("cli.no_output")));
      } else if (!chunks.length) {
        console.log(formatMarkdown(result.text));
      }
    } else {
      console.error(`${t("error.prefix")}${result.error}`);
      if (result.text || chunks.length > 0) {
        console.log(formatMarkdown(result.text || chunks.join("")));
      }
      process.exit(1);
    }
    agent.shutdown();
  } else {
    const configPath = join(homedir(), ".mma", "config.json");
    if (!existsSync(configPath)) {
      console.log(pc.yellow("\n  " + t("cli.first_run") + "\n"));
      const answers = await runSetup();
      const { config } = await bootstrap(undefined, projectDir, noAgentsMd, exitOnComplete);
      config.provider.type = answers.provider;
      config.provider.baseUrl = answers.apiBase;
      config.provider.apiKey = answers.apiKey;
      config.model = answers.model;
      config.contextWindow = answers.contextWindow;
      config.maxToolIterations = answers.maxToolIterations;
      config.locale = answers.locale;
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
    );
    repl.start();
  }
}

main();

export { main };
