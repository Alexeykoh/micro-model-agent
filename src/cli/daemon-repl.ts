/**
 * Thin-REPL `mma --daemon <url>` (split W3b): клиент без `Agent`/`SessionManager`.
 *
 * Ходы, сессии, команды и конфиг живут в демоне; здесь — редактор ввода,
 * терминальный рендер событий и тонкая обвязка. Локальными остаются только
 * `/clear` и `/exit`; всё остальное уходит по wire.
 */
import { pc } from "../ui/colors";
import { t } from "../i18n/index";
import { errMsg } from "../utils";
import { getDefaultChannel } from "../output";
import { Renderer, isRichTerminal } from "../ui/renderer";
import { Completer } from "./completer";
import { createReplEditor } from "./repl-editor";
import { RemoteHost } from "../modules/daemon/remote-host";
import { readDaemonToken } from "../modules/daemon/protocol";

/** Параметры подключения тонкого клиента. */
export interface DaemonReplOptions {
  url: string;
  token?: string | null;
}

/** Висящий вопрос демона: следующая строка — ответ, а не ход. */
interface PendingQuestion {
  id: string;
  kind: string;
  options: string[];
}

/** Поднимает thin-REPL до закрытия редактора. */
export async function runDaemonRepl(opts: DaemonReplOptions): Promise<void> {
  const channel = getDefaultChannel();
  const host = new RemoteHost({ baseUrl: opts.url, token: opts.token ?? readDaemonToken() });
  const sessionId = await resolveSession(host);
  channel.writeLine(pc.dim(t("daemon.connect", { url: opts.url, session: sessionId })));

  const editor = createReplEditor({
    completer: new Completer(),
    history: [],
    maxHistory: 200,
    prompt: pc.green("› "),
  });
  const renderer = new Renderer({ rich: isRichTerminal(), channel });
  let pending: PendingQuestion | null = null;
  let closed = false;
  let exitRequested = false;

  const unsubscribe = host.subscribeEvents((ev) => {
    const data = (ev.data ?? {}) as Record<string, unknown>;
    switch (ev.type) {
      case "text.delta":
        renderer.text(String(data.chunk ?? ""));
        break;
      case "reasoning.delta":
        renderer.reasoning(String(data.chunk ?? ""));
        break;
      case "tool.start":
        renderer.toolStart(
          String(data.name ?? "tool"),
          (data.args ?? {}) as Record<string, unknown>,
        );
        break;
      case "tool.end":
        renderer.toolEnd(
          String(data.name ?? "tool"),
          Number(data.durationMs ?? 0),
          data.success === false,
        );
        break;
      case "question": {
        const options = Array.isArray(data.options) ? data.options.map(String) : [];
        pending = { id: String(data.id ?? ""), kind: String(data.kind ?? "text"), options };
        channel.writeLine(pc.cyan(t("daemon.question", { text: String(data.text ?? "") })));
        if (options.length > 0) {
          channel.writeLine(pc.dim(t("daemon.question_options", { options: options.join(" · ") })));
        }
        break;
      }
      case "task.finished":
      case "task.failed":
      case "task.cancelled":
        channel.writeLine("");
        break;
    }
  });

  const onLine = async (line: string): Promise<void> => {
    if (pending) {
      const question = pending;
      pending = null;
      await answerQuestion(host, question, line, channel);
      return;
    }
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed === "/exit" || trimmed === "/quit") {
      exitRequested = true;
      return;
    }
    if (trimmed === "/clear") {
      channel.clearScreen();
      return;
    }
    if (trimmed === "/help") {
      channel.writeLine(t("daemon.help"));
      return;
    }
    if (trimmed.startsWith("/")) {
      await runRemoteCommand(host, trimmed, channel);
      return;
    }
    if (host.isBusy()) channel.writeLine(pc.dim(t("daemon.busy")));
    host.submit(trimmed).catch((err) => {
      channel.writeLine(pc.red(t("daemon.submit_failed", { error: errMsg(err) })));
    });
  };

  // Строки обрабатываются по очереди: вывод команды не перемешивается со
  // следующим промптом, а `/exit` не обгоняет уже начатую команду.
  let chain: Promise<void> = Promise.resolve();
  editor.on("line", (line) => {
    chain = chain
      .then(() => onLine(line))
      .then(() => {
        if (exitRequested) {
          closed = true;
          editor.close();
          return;
        }
        if (!closed) editor.prompt();
      });
  });
  await new Promise<void>((resolve) => {
    // Паiped stdin закрывается раньше, чем досохнет очередь строк: ждём её.
    editor.on("close", () => {
      void chain.then(() => resolve());
    });
    editor.prompt();
  });

  unsubscribe();
  host.dispose();
  channel.writeLine(pc.dim(t("daemon.disconnected", { url: opts.url })));
}

/** Активная сессия демона; иначе первая из списка или новая. */
async function resolveSession(host: RemoteHost): Promise<string> {
  const state = await host.getState();
  if (state.sessionId) {
    host.setSessionId(state.sessionId);
    return state.sessionId;
  }
  const sessions = await host.listSessions();
  if (sessions[0]) {
    host.setSessionId(sessions[0].id);
    return sessions[0].id;
  }
  const created = await host.createSession("daemon");
  host.setSessionId(created.id);
  return created.id;
}

/** Команда демона; вывод печатается строками, ошибка — жёлтым. */
async function runRemoteCommand(
  host: RemoteHost,
  line: string,
  channel: ReturnType<typeof getDefaultChannel>,
): Promise<void> {
  const result = await host.executeCommand(line);
  for (const out of result.output) channel.writeLine(out);
  if (!result.ok) channel.writeLine(pc.yellow(result.error ?? "command failed"));
}

/** Ответ на вопрос: для choice — номер варианта, для text — строка. */
async function answerQuestion(
  host: RemoteHost,
  question: PendingQuestion,
  line: string,
  channel: ReturnType<typeof getDefaultChannel>,
): Promise<void> {
  const value = question.kind === "choice" ? toChoiceIndexes(question.options, line.trim()) : line;
  try {
    await host.answer(question.id, value);
  } catch (err) {
    channel.writeLine(pc.red(t("daemon.answer_failed", { error: errMsg(err) })));
  }
}

/** `1,3` → `[0,2]`; нераспознанное не превращается в ложный выбор. */
function toChoiceIndexes(options: string[], raw: string): number[] {
  const out: number[] = [];
  for (const part of raw.split(/[,\s]+/).filter(Boolean)) {
    const n = Number(part);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) out.push(n - 1);
  }
  return out;
}
