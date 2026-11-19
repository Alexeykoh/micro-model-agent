/**
 * Дописывает запись в секцию `## [Unreleased]` файла `CHANGELOG.md`.
 *
 * Зачем скрипт: файл весит ~450 КБ. Читать его целиком в контекст и
 * переписывать ради одной строки — дорого и рискованно (легко потерять
 * историю). Скрипт вставляет пункт в нужную подсекцию и сохраняет остальные
 * байты, включая CRLF-переводы строк.
 *
 * Использование:
 *   bun run changelog:add Fixed "текст записи"
 *   echo "текст записи" | bun run changelog:add Fixed
 *
 * Секции: Added, Changed, Deprecated, Removed, Fixed, Security, Tests.
 * Пункт встаёт в начало своей секции: в файле принято «свежее сверху».
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = join(root, "CHANGELOG.md");

/** Порядок подсекций Keep a Changelog; новых секций ставим в конец. */
const SECTION_ORDER = [
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
  "Tests",
] as const;

export interface AppendResult {
  text: string;
  changed: boolean;
}

/** Приводит имя секции к каноническому написанию. */
export function canonicalSection(raw: string): string {
  const clean = raw.trim();
  const known = SECTION_ORDER.find((section) => section.toLowerCase() === clean.toLowerCase());
  return known ?? clean;
}

function sectionRank(name: string): number {
  const index = SECTION_ORDER.indexOf(canonicalSection(name) as (typeof SECTION_ORDER)[number]);
  return index < 0 ? SECTION_ORDER.length : index;
}

/** Строки пункта списка: первая с `- `, продолжение с отступом в два пробела. */
export function formatEntry(message: string): string[] {
  const body = message
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^\s*[-*]\s+/, "")
    .trim();
  if (!body) throw new Error("changelog-add: empty entry");

  const [first, ...rest] = body.split("\n");
  const lines = [`- ${first.trimEnd()}`];
  for (const line of rest) lines.push(line.trim() === "" ? "" : `  ${line.trimEnd()}`);
  return lines;
}

/**
 * Вставляет пункт в `## [Unreleased]`.
 *
 * Чистая функция: получает текст файла, возвращает новый текст. Остальные
 * байты не меняются, кроме перевода строк, который сохраняется как в исходнике.
 */
export function appendChangelogEntry(
  source: string,
  section: string,
  message: string,
): AppendResult {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);

  const unreleased = lines.findIndex((line) => /^##\s+\[Unreleased\]\s*$/i.test(line));
  if (unreleased < 0) throw new Error("changelog-add: `## [Unreleased]` section not found");

  let blockEnd = lines.length;
  for (let index = unreleased + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      blockEnd = index;
      break;
    }
  }

  const heading = canonicalSection(section);
  if (!heading) throw new Error("changelog-add: empty section name");
  const entry = formatEntry(message);

  const headings: Array<{ at: number; name: string }> = [];
  for (let index = unreleased + 1; index < blockEnd; index += 1) {
    const match = /^###\s+(.*?)\s*$/.exec(lines[index]);
    if (match) headings.push({ at: index, name: match[1] });
  }

  const current = headings.find((item) => item.name.toLowerCase() === heading.toLowerCase());
  const scopeStart = current ? current.at : unreleased + 1;
  const scopeEnd = current
    ? (headings.find((item) => item.at > current.at)?.at ?? blockEnd)
    : blockEnd;

  const existing = new Set(lines.slice(scopeStart + 1, scopeEnd).map((line) => line.trimEnd()));
  if (existing.has(entry[0])) return { text: source, changed: false };

  if (current) {
    // Свежее сверху: пункт встаёт первым в подсекции, после её заголовка.
    let at = current.at + 1;
    if (lines[at] !== undefined && lines[at].trim() === "") at += 1;
    const atHeading = at === current.at + 1;
    const needsBlankAfter = lines[at] !== undefined && /^#{2,3}\s/.test(lines[at]);
    lines.splice(at, 0, ...(atHeading ? [""] : []), ...entry, ...(needsBlankAfter ? [""] : []));
    return { text: lines.join(eol), changed: true };
  }

  // Подсекции нет: вставляем её по каноническому порядку.
  const rank = sectionRank(heading);
  const next = headings.find((item) => sectionRank(item.name) > rank);
  const at = next ? next.at : blockEnd;
  const lead = at > 0 && lines[at - 1].trim() !== "" ? [""] : [];
  lines.splice(at, 0, ...lead, `### ${heading}`, "", ...entry, "");
  return { text: lines.join(eol), changed: true };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function usage(): string {
  return [
    'Usage: bun run changelog:add <Added|Changed|Fixed|Removed|Security|Tests> "entry text"',
    '       echo "entry text" | bun run changelog:add Fixed',
  ].join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  while (argv[0] === "--") argv.shift();

  const section = argv.shift();
  if (!section) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 1;
    return;
  }

  const message = argv.join(" ").trim() || (await readStdin()).trim();
  if (!message) {
    process.stderr.write(`changelog-add: entry text is required\n${usage()}\n`);
    process.exitCode = 1;
    return;
  }

  const before = await readFile(changelogPath, "utf8");
  const { text, changed } = appendChangelogEntry(before, section, message);
  if (!changed) {
    process.stdout.write(`[changelog] entry already present in ${canonicalSection(section)}\n`);
    return;
  }

  await writeFile(changelogPath, text, "utf8");
  process.stdout.write(`[changelog] appended to ${canonicalSection(section)}\n`);
}

if (import.meta.main) await main();
