// CLI `mma undo`: откат правок файлов через порт `changes`.
// `runUndo` экспортируется в том числе для slash-команды REPL.
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { bootstrap } from "../core/bootstrap";
import { t } from "../i18n/index";
import { createFileChangesPort } from "../modules/changes";
import { matchProtectedPath } from "../modules/security/protected-paths";
import { getDefaultChannel } from "../output";
import { fail } from "./exit-code";

interface Parsed {
  path?: string;
  steps: number;
  force: boolean;
  turn?: string | true;
  list: boolean;
  session?: string;
}

function parseUndoArgs(args: string[]): Parsed {
  const out: Parsed = { steps: 1, force: false, list: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--force") out.force = true;
    else if (a === "--list") out.list = true;
    else if (a === "--turn") {
      out.turn = args[i + 1] && !args[i + 1]!.startsWith("--") ? args[++i]! : true;
    } else if (a === "--steps") {
      const raw = Number(args[++i]);
      if (!Number.isSafeInteger(raw) || raw < 1) return { ...out, steps: 0 };
      out.steps = raw;
    } else if (a === "--session") out.session = args[++i];
    else if (!a.startsWith("--")) out.path ??= a;
  }
  return out;
}

/** Откат правок: только явная цель (path или turn), список — `--list`. */
export async function runUndo(
  args: string[],
  write: (line: string, stream?: "stderr") => void,
): Promise<void> {
  const parsed = parseUndoArgs(args);
  if (parsed.steps === 0) {
    write(t("changes.invalid_steps"), "stderr");
    return;
  }
  const turn = typeof parsed.turn === "string" ? Number(parsed.turn) : undefined;
  if (turn !== undefined && (!Number.isSafeInteger(turn) || turn < 1)) {
    write(t("changes.invalid_turn"), "stderr");
    return;
  }
  if (parsed.path && parsed.turn !== undefined) {
    write(t("changes.path_and_turn"), "stderr");
    return;
  }
  if (!parsed.list && !parsed.path && parsed.turn === undefined) {
    write(t("changes.path_or_turn_required"), "stderr");
    return;
  }

  const boot = await bootstrap();
  const sessionId = parsed.session ?? boot.sessionManager.getActive();
  if (!sessionId) {
    write(t("changes.no_session"), "stderr");
    return;
  }
  const baseDir = boot.baseDir;
  const port = createFileChangesPort({
    sessionManager: boot.sessionManager,
    getConfig: () => boot.config,
  });

  if (parsed.list) {
    const entries = port.list({ sessionId, baseDir, path: parsed.path, limit: 50 });
    for (const e of entries) {
      write(`${e.id} · ${e.op} · ${e.path} · ${t("changes.list.turn", { turn: e.turn })}`);
    }
    return;
  }

  const authorize = (path: string): string | null => {
    const abs = resolve(baseDir, path);
    const pattern = matchProtectedPath(baseDir, abs);
    if (pattern) return t("changes.protected", { path, pattern });
    if (lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink()) {
      return t("changes.symlink_refused", { path });
    }
    return null;
  };

  const result = port.undo({
    sessionId,
    baseDir,
    path: parsed.path,
    steps: parsed.steps,
    turn,
    force: parsed.force,
    authorize,
  });
  const detail = result.items
    .map((i) =>
      i.ok
        ? `${i.path}: ${t("changes.reason.restored")}`
        : `${i.path}: ${i.reason ?? t("changes.reason.unknown")}`,
    )
    .join("; ");
  write(
    result.ok
      ? t("changes.result_ok", { detail })
      : t("changes.result_fail", {
          detail: detail || (result.message ?? t("changes.reason.unknown")),
        }),
    result.ok ? undefined : "stderr",
  );
}

export function buildUndoCommand(program: Command): void {
  program
    .command("undo")
    .description(t("cli.undo"))
    .argument("[path]", t("cli.undo_path"))
    .option("--steps <n>", t("cli.undo_steps"), "1")
    .option("--force", t("cli.undo_force"))
    .option("--turn [n]", t("cli.undo_turn"))
    .option("--list", t("cli.undo_list"))
    .option("--session <id>", t("cli.undo_session"))
    .action(async (
      path: string | undefined,
      opts: {
        steps: string;
        force?: boolean;
        turn?: string | boolean;
        list?: boolean;
        session?: string;
      },
    ) => {
      const args: string[] = path ? [path] : [];
      if (opts.force) args.push("--force");
      if (opts.list) args.push("--list");
      if (opts.session) args.push("--session", opts.session);
      if (opts.steps !== "1") args.push("--steps", opts.steps);
      if (opts.turn !== undefined) {
        args.push("--turn");
        if (typeof opts.turn === "string") args.push(opts.turn);
      }
      await runUndo(args, (line, stream) => {
        if (stream === "stderr") fail(line);
        else getDefaultChannel().writeLine(line);
      });
    });
}
