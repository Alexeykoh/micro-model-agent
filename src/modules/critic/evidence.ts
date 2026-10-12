// Сборка пакета доказательств для критика: дайджест тулов, файлы, команды.
import { readFileSync } from "fs";
import { execFileSync } from "node:child_process";
import { resolve } from "path";
import type { EvidencePack } from "./types";
import { summarizeToolArgs, redactContextSecrets } from "../../core/api";
import { extractAmountClaims, normalizeDigits } from "../../core/hallucination/web-claims";

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
  /** Финальный ответ модели для ходов без мутаций (чат-доставка). Обрезается и редактируется здесь. */
  answerText?: string;
}

const MAX_DIGEST_LINES = 40;
/** Хвост вывода, прикладываемый к bash/фейловым строкам дайджеста (результаты тестов/сборки — сигнал верификации). */
const MAX_DIGEST_OUTPUT_CHARS = 300;
const MAX_EXCERPT_FILES = 5;
const MAX_EXCERPT_CHARS = 1200;
/** Выдержка ответа модели в пакете (у критика свой бюджет; секреты редактируются). */
const MAX_ANSWER_CHARS = 2000;
/** Минимальный объём вывода web_fetch, считающийся содержательным (не навбар/шелл). */
const MIN_GROUNDING_CHARS = 200;
/** Сетевые тулы, дающие веб-обоснование. */
const GROUNDING_TOOLS = new Set(["web_fetch", "web_search", "web_browse"]);

/** Веб-обоснование по событиям тулов: сколько было сетевых чтений и дало ли хоть одно контент. */
function computeWebGrounding(
  events: EvidenceToolEvent[],
  answerText?: string,
): { attempted: number; verified: boolean; unverifiedClaims?: string[] } | undefined {
  const web = events.filter((ev) => GROUNDING_TOOLS.has(ev.tool));
  if (web.length === 0) return undefined;
  const fetchedText = normalizeDigits(
    web
      .filter((ev) => ev.tool === "web_fetch" && ev.ok !== false && (ev.output?.length ?? 0) >= MIN_GROUNDING_CHARS)
      .map((ev) => ev.output ?? "")
      .join("\n"),
  );
  const hadContent = fetchedText.length > 0;
  // Claim-aware: суммы из ответа, которых нет в прочитанном тексте, помечаем
  // явно — критик должен считать это concern (выдуманные числа после веба).
  const claims = answerText ? extractAmountClaims(answerText) : [];
  const unverifiedClaims = hadContent ? claims.filter((c) => !fetchedText.includes(c)) : claims;
  return {
    attempted: web.length,
    verified: hadContent && unverifiedClaims.length === 0,
    unverifiedClaims: unverifiedClaims.length > 0 ? unverifiedClaims : undefined,
  };
}

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
  // Добивка из git: ловит правки мимо файловых тулов (см. gitChangedFiles).
  if (input.baseDir) {
    for (const f of gitChangedFiles(input.baseDir)) changedFiles.add(f);
  }
  return {
    task: input.task,
    planSummary: input.planSummary,
    changedFiles: [...changedFiles],
    commands,
    toolDigest: digest.slice(-MAX_DIGEST_LINES).join("\n"),
    fileExcerpts: input.baseDir ? readExcerpts(input.baseDir, [...changedFiles]) : undefined,
    answerExcerpt: input.answerText
      ? redactContextSecrets(input.answerText).slice(0, MAX_ANSWER_CHARS)
      : undefined,
    webGrounding: computeWebGrounding(input.toolEvents, input.answerText),
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

/** Лимит git-добивки: evidence-пакет обязан оставаться компактным. */
const MAX_GIT_FILES = 20;

/** Разбирает одну строку `git status --porcelain` в путь (null — пропуск). */
function parsePorcelainLine(line: string): string | null {
  if (line.length < 4) return null;
  let p = line.slice(3).trim();
  // Переименования: "old -> new" — берём новое имя.
  const arrow = p.indexOf(" -> ");
  if (arrow !== -1) p = p.slice(arrow + 4).trim();
  // Porcelain квотит пути со спецсимволами.
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    try {
      p = JSON.parse(p) as string;
    } catch {
      p = p.slice(1, -1);
    }
  }
  return p || null;
}

/**
 * Фактически изменённые файлы из git (ses_mup6p61q): правки, внесённые мимо
 * файловых тулов (Bun-скрипты через bash, heredoc, внешние редакторы),
 * невидимы для changedFileOf — критик судил по пустому списку и выдал ложный
 * concern («styles.css is not in git diff», хотя файл был изменён).
 * `git status --porcelain` видит staged + unstaged + untracked. Fail-open:
 * не репозиторий / нет git — пусто, поведение как раньше.
 */
function gitChangedFiles(baseDir: string): string[] {
  let out: string;
  try {
    out = execFileSync("git", ["status", "--porcelain"], {
      cwd: resolve(baseDir),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const line of out.split("\n")) {
    const p = parsePorcelainLine(line);
    if (p) files.push(p);
    if (files.length >= MAX_GIT_FILES) break;
  }
  return files;
}

/** Событие bash как запись команды, видимая критику (с ограниченным хвостом вывода). */
function commandOf(ev: EvidenceToolEvent): EvidencePack["commands"][number] | undefined {
  if (ev.tool !== "bash" || typeof ev.args?.command !== "string") return undefined;
  return {
    command: ev.args.command,
    // Реальный код неизвестен (в evidence только флаг успеха) — для успеха
    // не синтезируем 0, иначе критик видит выдуманные коды; рендер покажет "?".
    exitCode: ev.ok === false ? 1 : undefined,
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
