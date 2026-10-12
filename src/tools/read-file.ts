/** Тул чтения файла: постранично, со стримингом больших файлов. */
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from "fs";
import { extname } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { safeResolvePath } from "./path-utils";
import { errMsg } from "../utils";

/**
 * Строк на вызов read_file по умолчанию. Намеренно больше MAX_PREVIEW_LINES
 * (15): дефолт 15 заставлял модель делать 10–17 вызовов на файл, что заливало
 * контекст и дёргало компакцию каждые 15 итераций (наблюдено: 96 вызовов
 * read_file, 11 компакций за ~20 мин со сносом задачи). 300 строк покрывают
 * типичный файл за один вызов, вывод всё равно ограничен.
 */
const DEFAULT_LIMIT = 300;
/** Жёсткий потолок явного `limit` (тул исключён из усечения по бюджету). */
const MAX_READ_LIMIT = 2000;

/**
 * Файлы крупнее — через ограниченный стриминг вместо readFileSync (который
 * грузит весь файл в память ради пары сотен строк).
 */
const LARGE_FILE_BYTES = 1024 * 1024;
const STREAM_CHUNK = 256 * 1024;

/**
 * Ограниченное построчное чтение больших файлов: стримит чанками, собирает
 * только окно [offset, offset+limit), остаток переводов строк считает сырым
 * (без декода) для total. Память ограничена при любом размере файла.
 */
function readLineSlice(
  path: string,
  offset: number,
  limit: number,
): { selected: string; total: number } {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(STREAM_CHUNK);
    let pos = 0;
    let carry = "";
    let lineNumber = 1;
    let total = 0;
    const collected: string[] = [];
    const endLine = offset + limit; // exclusive

    while (true) {
      const bytes = readSync(fd, buf, 0, STREAM_CHUNK, pos);
      if (bytes === 0) break;
      pos += bytes;
      const chunk = carry + buf.toString("utf-8", 0, bytes);
      const parts = chunk.split("\n");
      carry = parts.pop() ?? "";
      for (const line of parts) {
        total++;
        if (lineNumber >= offset && lineNumber < endLine) collected.push(line);
        lineNumber++;
      }
      if (lineNumber >= endLine && collected.length >= limit) {
        // Окно собрано — остаток переводов строк считаем без декодирования.
        const rest: Buffer[] = [];
        while (true) {
          const n = readSync(fd, buf, 0, STREAM_CHUNK, pos);
          if (n === 0) break;
          pos += n;
          rest.push(Buffer.from(buf.subarray(0, n)));
        }
        const tail = Buffer.concat([...rest, Buffer.from(carry, "utf-8")]);
        for (let i = 0; i < tail.length; i++) if (tail[i] === 0x0a) total++;
        // Плюс финальная строка без перевода — только если файл им не
        // кончается, иначе посчитаем фантомную пустую строку.
        if (tail.length > 0 && tail[tail.length - 1] !== 0x0a) total++;
        return { selected: collected.join("\n"), total };
      }
    }
    if (carry.length > 0 || total === 0) {
      total++;
      if (lineNumber >= offset && lineNumber < endLine) collected.push(carry);
    }
    return { selected: collected.join("\n"), total };
  } finally {
    closeSync(fd);
  }
}

/** Читает файл постранично (offset/limit); кешируемый, с cap вывода. */
export const readFileTool: ToolDefinition = {
  name: "read_file",
  security: { caps: [{ fs: "read" }], pathArgs: ["path"] },
  icon: "👀",
  description: `Read a file from the filesystem. Reads up to ${DEFAULT_LIMIT} lines at a time by default; use offset to page through large files.`,
  tags: ["file", "code"],
  boundedOutput: true,
  cacheable: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to read" },
      offset: {
        type: "number",
        description: `Starting line (1-indexed). Use offset=<next> from a truncated result to continue reading.`,
      },
      limit: {
        type: "number",
        description: `Number of lines to read (default ${DEFAULT_LIMIT})`,
      },
    },
    required: ["path"],
  },
  handler: async (ctx, args) => {
    const path = String(args.path);
    const resolved = safeResolvePath(ctx.baseDir, path);
    if (!existsSync(resolved)) {
      // Для относительных путей показываем, КУДА резолвилось: голое
      // "not found" не даёт модели отличить baseDir от cwd.
      const output =
        resolved !== path
          ? t("file.notfound_resolved", {
              path,
              resolved,
            })
          : t("file.notfound", { path });
      return { success: false, output };
    }
    // Кламп обоих: `offset: 0` давал slice(-1, end) с ПОСЛЕДНЕЙ строкой, а
    // безграничный `limit` (тул вне усечения по бюджету) тянул бы целый
    // большой файл в контекст.
    const offset = Math.max(
      1,
      typeof args.offset === "number" ? Math.floor(args.offset) : 1,
    );
    const limit = Math.min(
      MAX_READ_LIMIT,
      Math.max(1, typeof args.limit === "number" ? Math.floor(args.limit) : DEFAULT_LIMIT),
    );

    let lines: string[];
    let total: number;
    let selected: string;
    try {
      if (statSync(resolved).size > LARGE_FILE_BYTES) {
        const slice = readLineSlice(resolved, offset, limit);
        total = slice.total;
        selected = slice.selected;
      } else {
        const content = readFileSync(resolved, "utf-8");
        lines = content.split("\n");
        // Файл с финальным переводом даёт фантомный пустой элемент — снять,
        // чтобы счёт строк совпал со стриминг-путем.
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        total = lines.length;
        const end = Math.min(offset - 1 + limit, total);
        selected = lines.slice(offset - 1, end).join("\n");
      }
    } catch (err) {
      // Файл мог исчезнуть между existsSync и чтением (TOCTOU) или оказаться
      // директорией — возвращаем понятную ошибку, а не голый throw.
      return {
        success: false,
        output: t("file.read_failed", { path, error: errMsg(err) }),
      };
    }
    const end = Math.min(offset - 1 + limit, total);
    const ext = extname(resolved) || "(no extension)";
    const header = t("file.read_header", {
      path,
      ext,
      total: String(total),
      from: String(offset),
      to: String(end),
    });
    const truncated =
      end < total
        ? t("file.read_truncated", {
            remaining: String(total - end),
            next: String(end + 1),
          })
        : "";
    // Компактный display: заголовок уже показывает путь, доп. инфо (диапазон)
    // нужна только частичному чтению. Полное чтение — пусто, карточка в 2 строки.
    const fullRead = offset === 1 && end >= total;
    const display = fullRead
      ? ""
      : t("file.read_range", {
          from: String(offset),
          to: String(end),
          total: String(total),
        });
    return {
      success: true,
      output: `${header}\n${selected}${truncated}`,
      display,
    };
  },
};
