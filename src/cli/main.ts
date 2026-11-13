// Точка входа CLI: parse, маршрут веток (web/serve, one-shot, REPL), ранняя локаль.
import { createProgram } from "./commands";
import {
  bootstrap,
  setOneShotMode,
  setSessionAutocreate,
  applyReasoningCliOverride,
} from "../core/bootstrap";
import { sessionNeededFor } from "./command-scope";
import { Repl } from "./repl";
import { runSetup } from "./setup";
import { applyAnswersToConfig } from "./setup-order";
import { relaunchCli } from "./relaunch";
import { getDefaultChannel, setLogsToStderr, writeMachineJson } from "../output";
import { buildJsonError } from "./json-payload";
import { errMsg } from "../utils";
import { saveConfig, loadConfig } from "../config/config";
import { t, setLocale } from "../i18n/index";
import { pc } from "../ui/colors";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { installCrashHandlers } from "../core/crash-handler";
import { closestCommand } from "./command-suggest";
import { globalMmaDir } from "../config/paths";
import { MMA_ENV, readEnv } from "../config/env";
import { startAutoUpdate } from "./auto-update";
import { applyLogVisibility } from "./log-visibility";
import { dispatchLongRunningCommand } from "./main-web";
import { isJsonMode, runOneShot } from "./main-oneshot";
import { runDaemonRepl } from "./daemon-repl";

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

async function main(): Promise<void> {
  // Глобальные краш-хендлеры первым делом: каждый краш ложится в
  // ~/.mma/logs/crash.jsonl (с env-репортом), а не голым стеком в stderr.
  installCrashHandlers();

  // Windows: переключаем консоль на UTF-8, чтобы кириллица в changelog/
  // релизных заметках не превращалась в mojibake.
  if (process.platform === "win32") {
    try {
      const { execSync } = await import("node:child_process");
      execSync("chcp 65001", { stdio: "ignore" });
    } catch {
      // ignore
    }
    try {
      process.stdout.setDefaultEncoding?.("utf8");
      process.stderr.setDefaultEncoding?.("utf8");
    } catch {
      // ignore
    }
  }

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
  const valueOpts = new Set(["-d", "--dir", "--reasoning", "--daemon"]);
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
  // One-shot для любого первого позиционного аргумента, который не команда.
  if (firstPositional && !onboardingStart) {
    setOneShotMode(true);
  }
  // A-01: read-only команды не должны создавать сессию (см. command-scope.ts).
  const commandNames = new Set(program.commands.map((c) => c.name()));
  setSessionAutocreate(sessionNeededFor(firstPositional, commandNames));

  program.parse(process.argv);

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

  applyLogVisibility(verboseOpt);

  // Thin-REPL: локальный рантайм не поднимаем вовсе — всё состояние в демоне.
  const daemonUrl = typeof opts.daemon === "string" ? opts.daemon : undefined;
  if (daemonUrl) {
    await runDaemonRepl({ url: daemonUrl });
    return;
  }

  // `web`/`serve` долгоживущие: их action — no-op, сервер стартует здесь, после
  // parse, чтобы пережить one-shot exit-хук (на них он осознанно не вешается).
  if (await dispatchLongRunningCommand(program, { projectDir, noAgentsMd })) {
    return;
  }

  const isSubcommand =
    program.args.length > 0 && commandNames.has(program.args[0]) && !onboardingStart;

  if (isSubcommand) {
    // Машинный stdout подкоманд (config show JSON и т. п.): диагностические
    // логи → stderr. Блоки writeLine остаются в stdout. Зеркалит A-14
    // (`session export --out -`).
    setLogsToStderr(true);
    return;
  }

  // Тайпо-сторож: субкоманда с опечаткой не должна молча уходить в LLM как
  // промпт ("mma sesion list" → чат). На near-miss известной команды — warn и выход;
  // свободные промпты так не выглядят никогда.
  if (program.args.length > 0 && !onboardingStart) {
    const suggestion = closestCommand(program.args[0], [...commandNames]);
    if (suggestion && suggestion !== program.args[0]) {
      getDefaultChannel().writeLine(
        pc.yellow(`${t("cli.unknown_command", { input: program.args[0], suggestion })}`),
        "stderr",
      );
      process.exit(2);
    }
  }

  if (program.args.length > 0 && !onboardingStart) {
    await runOneShot({
      prompt: program.args.join(" "),
      projectDir,
      noAgentsMd,
      exitOnComplete,
      reasoningLevel,
      verbose: verboseOpt,
      contextLog,
      json: jsonOpt,
    });
    return;
  }

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

main().catch((err) => {
  // Throw до/во время bootstrap иначе оставил бы `--json`-вызывающих с пустым
  // stdout; эмитим валидный failure-документ вместо человеческого стека.
  if (isJsonMode()) {
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
