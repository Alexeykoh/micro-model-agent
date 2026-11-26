// Admission результата тула (OO-1): крупный вывод не входит в контекст
// дословно — спилл в .mma/context/<session>/ + дескриптор с превью и путём.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { estimateTokens } from "../llm/token-counter";
import { t } from "../i18n/index";
import { DEFAULT_ADMIT_MAX_TOKENS } from "../config/defaults";
import type { ToolCall, ToolContext, ToolResult } from "./types";

/** Сколько первых строк вывода оставить в превью дескриптора. */
const PREVIEW_LINES = 12;
/** Потолок превью в символах: одна минифицированная строка не должна просочиться. */
const PREVIEW_MAX_CHARS = 2000;
/** Каталог спилла относительно baseDir. */
const DEFAULT_SPILL_DIR = ".mma/context";
/** Возраст спилла, после которого он считается мусором. */
const SPILL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Кап файлов в одной сессии — защита от бесконечного роста при частых admission. */
const SPILL_MAX_PER_SESSION = 50;

/**
 * Стабильный идентификатор артефакта: путь от рабочего каталога с прямыми
 * слешами. Не зависит от разделителей ОС и остаётся тем же после компакции.
 */
export function artifactHandle(baseDir: string, artifact: string): string {
  return relative(resolve(baseDir), resolve(artifact)).replace(/\\/g, "/");
}

/** Параметры уборки спиллов; `skipDir` — сессия, которая сейчас пишет. */
export interface SpillGcOptions {
  now?: number;
  skipDir?: string;
  ttlMs?: number;
  maxPerSession?: number;
}

function removeQuietly(path: string): boolean {
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    // Файл мог исчезнуть в параллельном прогоне — уборка идемпотентна.
    return false;
  }
}

/**
 * Retention для `.mma/context/<session>/`: удаляет старые файлы и лишние
 * сверх капа в чужих сессиях. Текущую сессию не трогаем — её артефакты ещё
 * можно открыть по дескриптору из активного контекста.
 */
export function pruneSpills(spillRoot: string, opts: SpillGcOptions = {}): { removed: number } {
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? SPILL_TTL_MS;
  const cap = opts.maxPerSession ?? SPILL_MAX_PER_SESSION;
  let removed = 0;
  let sessions: Dirent[];
  try {
    sessions = readdirSync(spillRoot, { withFileTypes: true });
  } catch {
    return { removed };
  }
  for (const session of sessions) {
    if (!session.isDirectory()) continue;
    const dir = join(spillRoot, session.name);
    if (opts.skipDir && resolve(dir) === resolve(opts.skipDir)) continue;
    let files: Array<{ path: string; mtime: number }>;
    try {
      files = readdirSync(dir, { withFileTypes: true })
        .filter((f) => f.isFile())
        .map((f) => {
          const path = join(dir, f.name);
          return { path, mtime: statSync(path).mtimeMs };
        })
        .sort((a, b) => a.mtime - b.mtime);
    } catch {
      continue;
    }
    for (const file of files) {
      if (now - file.mtime > ttl && removeQuietly(file.path)) removed++;
    }
    const alive = files.filter((f) => existsSync(f.path));
    for (const file of alive.slice(0, Math.max(0, alive.length - cap))) {
      if (removeQuietly(file.path)) removed++;
    }
  }
  return { removed };
}

export interface AdmitOptions {
  baseDir: string;
  sessionId: string;
  maxTokens: number;
  source?: string;
  spillDir?: string;
}

/** True, если `candidate` строго внутри `root` (или равен ему). */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Пропускает результат как есть, если он мал или неуспешен. Иначе спилит вывод
 * в файл и подменяет его компактным дескриптором (превью + путь артефакта).
 * @param result результат тула; @param opts параметры admission.
 * @returns исходный либо урезанный до дескриптора результат.
 */
export function admitToolResult(result: ToolResult, opts: AdmitOptions): ToolResult {
  // Terminal: дескриптор уже admitted — иначе второй проход дал бы
  // дескриптор-из-дескриптора. `artifactPath` ставит и subagent result_mode:"file".
  if (result.artifactPath) return result;
  const output = result.output ?? "";
  if (!result.success || !output) return result;
  const tokens = estimateTokens(output);
  if (tokens <= opts.maxTokens) return result;

  // Jail: спилл обязан остаться внутри baseDir. Если кастомный spillDir уводит
  // наружу — откатываемся на дефолтный; если и sessionId выводит за baseDir,
  // это порча входа, а не путь — падаем (безопаснее, чем писать наружу).
  const baseRoot = resolve(opts.baseDir);
  const candidate = resolve(baseRoot, opts.spillDir ?? DEFAULT_SPILL_DIR, opts.sessionId);
  const dir = isInside(baseRoot, candidate)
    ? candidate
    : resolve(baseRoot, DEFAULT_SPILL_DIR, opts.sessionId);
  if (!isInside(baseRoot, dir)) {
    throw new Error(`admitToolResult: spill path escapes baseDir: ${dir}`);
  }

  // Уборка чужих сессий перед записью: спиллы не копятся между прогонами.
  pruneSpills(dirname(dir), { now: Date.now(), skipDir: dir });
  mkdirSync(dir, { recursive: true });
  // randomUUID-суффикс: два admission в одну миллисекунду не перезатрут друг друга.
  const artifact = join(dir, `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.txt`);
  writeFileSync(artifact, output, "utf8");

  const outLines = output.split("\n");
  const lines = outLines.length;
  const previewRaw = outLines.slice(0, PREVIEW_LINES).join("\n");
  const preview =
    previewRaw.length > PREVIEW_MAX_CHARS
      ? `${previewRaw.slice(0, PREVIEW_MAX_CHARS).trimEnd()}…`
      : previewRaw;
  const digest = createHash("sha256").update(output).digest("hex");
  const descriptor = t("tool.output_admitted", {
    tokens: String(tokens),
    lines: String(lines),
    bytes: String(Buffer.byteLength(output, "utf8")),
    artifact,
    handle: artifactHandle(baseRoot, artifact),
    digest,
    source: opts.source ?? "-",
    preview,
  });
  return {
    ...result,
    output: descriptor,
    artifactPath: artifact,
    display: t("tool.output_admitted_display", {
      tokens: String(tokens),
      lines: String(lines),
    }),
  };
}

/**
 * Admission в точке исполнения (OO-1): берёт порог и спилл-параметры из
 * `ToolContext`, `source` — из аргумента-пути вызова. Одна точка для всех тулов.
 */
export function admitFromContext(
  result: ToolResult,
  ctx: ToolContext,
  call: ToolCall,
): ToolResult {
  const path = call.arguments?.path;
  try {
    return admitToolResult(result, {
      baseDir: ctx.baseDir,
      sessionId: ctx.sessionId ?? "default",
      maxTokens: ctx.config?.contextBudget?.admitMaxTokens ?? DEFAULT_ADMIT_MAX_TOKENS,
      source: typeof path === "string" ? path : undefined,
    });
  } catch (e) {
    // Best-effort (OO-1): сбой спилла/пути не должен превращать успешный тул в
    // ошибку — логируем и отдаём сырьё как есть (admission деградирует, тул — нет).
    const cause = e instanceof Error ? e.message : String(e);
    ctx.logger.warn(`admission skipped: ${cause}`);
    // INV-15: fail-open путь обязан оставить различимый сигнал в session.jsonl,
    // иначе «сломался» неотличим от «admission не нужен».
    ctx.onDiagnostic?.({
      source: "tool:admission",
      operation: "admit",
      kind: "degraded",
      cause,
      recoverable: true,
    });
    return result;
  }
}
