/**
 * Гейт покрытия: запускает `bun test --coverage`, парсит строку `All files` из
 * текстового отчёта и падает при падении ниже порогов (зафиксированы
 * 2026-11-09 по замеру 88.30% funcs / 91.65% lines).
 *
 * Пороги стоят с запасом ~1.5 п.п. от замера — ловят заметную потерю покрытия,
 * а не шум между прогонами.
 */
import { spawnSync } from "child_process";

const MIN_FUNCS = 87;
const MIN_LINES = 90;

const res = spawnSync("bun", ["test", "--coverage"], {
  encoding: "utf-8",
  stdio: ["inherit", "pipe", "pipe"],
});

const out = (res.stdout ?? "") + (res.stderr ?? "");
process.stdout.write(res.stdout ?? "");
process.stderr.write(res.stderr ?? "");

const match = out.match(/All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/);
if (!match) {
  process.stderr.write("coverage gate: `All files` line not found in coverage output\n");
  process.exit(1);
}

const funcs = Number.parseFloat(match[1]);
const lines = Number.parseFloat(match[2]);
// Тесты сами падают по другим причинам (known: tests/core/llm-truncation-recovery);
// гейт покрывает только покрытие, код возврата тестов — дело шага `Unit tests`.
const failed: string[] = [];
if (funcs < MIN_FUNCS) failed.push(`funcs ${funcs}% < ${MIN_FUNCS}%`);
if (lines < MIN_LINES) failed.push(`lines ${lines}% < ${MIN_LINES}%`);

process.stdout.write(`\nCoverage: funcs ${funcs}% (min ${MIN_FUNCS}%), lines ${lines}% (min ${MIN_LINES}%)\n`);

if (failed.length > 0) {
  process.stderr.write(`coverage gate FAILED: ${failed.join(", ")}\n`);
  process.exit(1);
}
process.stdout.write("coverage gate passed\n");
// Код возврата тестов не прячем: `bun test` неуспех должен ронять CI тем же шагом.
process.exit(res.status ?? 1);
