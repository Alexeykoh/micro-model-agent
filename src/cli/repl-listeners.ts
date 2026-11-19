/**
 * Слушатели REPL: строки/закрытие ввода, resize терминала, спецклавиши и
 * глобальный SIGINT с двойным Ctrl+C.
 *
 * Вынесено из `repl.ts` (правило 6). Глобальный хендлер — модульная переменная:
 * он всё равно один на процесс, а не на инстанс.
 */
import { pc } from "../ui/colors";
import { LineEditor, type LineInput } from "../ui/line-editor";
import { t } from "../i18n/index";
import { currentExitCode } from "./exit-code";
import { saveHistory, type ReplHistoryHost } from "./repl-history";
import { handleSpecialKey, type ReplKeysHost } from "./repl-keys";
import type { Agent } from "../core/agent";
import type { OutputChannel } from "../output";

/** Минимальный вид диспетчера строк, нужный слушателю `line`. */
export interface LineListener {
  onLine(line: string): void;
}

/** Поля `Repl`, нужные слушателям. */
export interface ReplListenersHost extends ReplHistoryHost, ReplKeysHost {
  rl: LineInput;
  lineDispatcher: LineListener;
  running: boolean;
  exitOnClose: boolean;
  activeRenderer: { onResize(): void } | null;
  agent: Agent;
  output: OutputChannel;
}

/** Глобальный SIGINT-хендлер, общий на все инстансы REPL (см. registerSigint). */
let sigintHandler: (() => void) | undefined;

export function setupListeners(host: ReplListenersHost): void {
  // Порядок строк и мультистрочный буфер — в `LineDispatcher` (правило 6).
  host.rl.on("line", (line: string) => host.lineDispatcher.onLine(line));

  host.rl.on("close", () => {
    host.running = false;
    saveHistory(host);
    host.agent.shutdown();
    // Закрываем лог сессии на выходе из REPL.
    host.logger?.closeSessionLog();
    // Код возврата мог задать путь запуска (отказ онбординга в non-TTY):
    // скрипт обязан увидеть 1, а не молчаливый 0.
    if (host.exitOnClose) process.exit(currentExitCode());
  });

  if (host.exitOnClose && !process.stdin.isTTY) {
    process.stdin.on("end", () => {
      host.running = false;
      saveHistory(host);
      host.agent.shutdown();
      // Закрываем лог сессии на выходе из REPL.
      host.logger?.closeSessionLog();
      process.exit(currentExitCode());
    });
  }

  if (host.rl instanceof LineEditor) {
    host.rl.onKeyInput = (str, key) => handleSpecialKey(host, str, key);
  }

  // Resize терминала: ширина перемеряется, иначе таблицы и линейки считаются
  // по старой ширине (аудит §8.12).
  const onResize = (): void => {
    host.activeRenderer?.onResize();
    if (!host.agentRunning) host.rl.prompt();
  };
  process.stdout.on("resize", onResize);
  process.on("SIGWINCH", onResize);

  let forceExitTimer: ReturnType<typeof setTimeout> | null = null;
  // Запас на очистку (сессия, MCP, дочерние процессы) после второго Ctrl+C.
  const FORCE_EXIT_MS = 5000;

  // Идемпотентная регистрация: второй Repl в том же процессе не добавляет
  // ещё один глобальный SIGINT-хендлер. Протёкшие хендлеры инстансов REPL,
  // созданные в тестах, стреляли process.exit(0) на ЛЮБОЙ process.emit("SIGINT")
  // в другом месте и молча убивали весь bun-раннер тестов.
  if (typeof sigintHandler === "function") {
    process.removeListener("SIGINT", sigintHandler);
  }
  sigintHandler = () => {
    if (host.agentRunning) {
      host.output.writeLine(pc.yellow(t("repl.ctrl_c_interrupt")));
      host.agent.shutdown();
      host.agentRunning = false;
      if (forceExitTimer) clearTimeout(forceExitTimer);
      forceExitTimer = setTimeout(() => {
        host.output.writeLine(pc.yellow(t("repl.force_exit")));
        process.exit(1);
      }, FORCE_EXIT_MS).unref();
    } else {
      process.exit(0);
    }
  };
  process.on("SIGINT", sigintHandler);
}
