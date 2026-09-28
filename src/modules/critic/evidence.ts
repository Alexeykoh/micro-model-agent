// Сборка пакета доказательств для критика: дайджест тулов, файлы, команды.
import { readFileSync } from "fs";
import { resolve } from "path";
import type { EvidencePack } from "./types";
import { summarizeToolArgs } from "../../core/agent/tool-output";

const MUTATING_TOOLS = new Set(["write_file", "edit_file", "delete_file", "move_file", "create_dir"]);

/** Мутация работы = тул, меняющий ФС (bash входит; plan/todo-бухгалтерия — нет). */
export function isWorkMutation(name: string): boolean {
  return MUTATING_TOOLS.has(name) || name === "bash";
}

/** Одно событие тула для пакета доказательств. */
export interface EvidenceToolEvent {
  tool: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  /** Хвост вывода тула (уже обрезан бюджетом выше по потоку). */
  output?: string;
}

/** Вход сборки пакета: задача, план, события тулов, корень проекта. */
export interface EvidenceInput {
  task: string;
  planSummary?: string;
  toolEvents: EvidenceToolEvent[];
  /** Корень проекта — если задан, изменённые файлы дочитываются (ограниченные выдержки), чтобы критик проверял контент, а не пути. */
  baseDir?: string;
}

const MAX_DIGEST_LINES = 40;
/** Хвост вывода, прикладываемый к bash/фейловым строкам дайджеста (результаты тестов/сборки — сигнал верификации). */
const MAX_DIGEST_OUTPUT_CHARS = 300;
const MAX_EXCERPT_FILES = 5;
const MAX_EXCERPT_CHARS = 1200;

/** Собирает EvidencePack из событий тулов: дайджест, файлы, команды, выдержки. */
export function buildEvidencePack(input: EvidenceInput): EvidencePack {
  const changedFiles = new Set<string>();
  const commands: EvidencePack["commands"] = [];
  const digest: string[] = [];
  for (const ev of input.toolEvents) {
    digest.push(digestLine(ev));
    const file = changedFileOf(ev);
    if (file) changedFiles.add(file);
    const cmd = commandOf(ev);
    if (cmd) commands.push(cmd);
  }
  return {
    task: input.task,
    planSummary: input.planSummary,
    changedFiles: [...changedFiles],
    commands,
    toolDigest: digest.slice(-MAX_DIGEST_LINES).join("\n"),
    fileExcerpts: input.baseDir ? readExcerpts(input.baseDir, [...changedFiles]) : undefined,
  };
}

/** Одна строка дайджеста на событие. Вывод bash (результаты тестов/сборки) и вывод
 *  ошибок идут вместе со строкой — иначе критик судит об успехе вслепую. */
function digestLine(ev: EvidenceToolEvent): string {
  const args = ev.args ? summarizeToolArgs(ev.args) : "";
  const line = `${ev.ok === false ? "✗" : "✓"} ${ev.tool} ${args}`.trim();
  if (ev.output && (ev.tool === "bash" || ev.ok === false)) {
    return `${line} » ${ev.output.slice(-MAX_DIGEST_OUTPUT_CHARS)}`;
  }
  return line;
}

/** Относительный путь файла, затронутого событием write/edit. */
function changedFileOf(ev: EvidenceToolEvent): string | undefined {
  if (ev.tool !== "write_file" && ev.tool !== "edit_file") return undefined;
  return typeof ev.args?.path === "string" ? ev.args.path : undefined;
}

/** Событие bash как запись команды, видимая критику (с ограниченным хвостом вывода). */
function commandOf(ev: EvidenceToolEvent): EvidencePack["commands"][number] | undefined {
  if (ev.tool !== "bash" || typeof ev.args?.command !== "string") return undefined;
  return {
    command: ev.args.command,
    exitCode: ev.ok === false ? 1 : 0,
    output: ev.output?.slice(-MAX_DIGEST_OUTPUT_CHARS),
  };
}

/** Best-effort ограниченные head-выдержки изменённых файлов. Нечитаемые (удалены, бинарные, вне root) — пропуск, никогда не бросает. */
function readExcerpts(baseDir: string, paths: string[]): Array<{ path: string; excerpt: string }> {
  const out: Array<{ path: string; excerpt: string }> = [];
  const root = resolve(baseDir);
  for (const p of paths.slice(0, MAX_EXCERPT_FILES)) {
    try {
      const abs = resolve(root, p);
      if (abs !== root && !abs.startsWith(`${root}/`) && !abs.startsWith(`${root}\\`)) continue;
      const text = readFileSync(abs, "utf-8");
      out.push({ path: p, excerpt: text.slice(0, MAX_EXCERPT_CHARS) });
    } catch {
      // Нечитаемый (удалён, бинарный, вне root) — молча пропускаем.
    }
  }
  return out;
}
