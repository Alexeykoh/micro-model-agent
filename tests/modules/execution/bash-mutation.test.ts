/**
 * Нудж «создай план» не должен срабатывать на read-only диагностику.
 *
 * DEBT(plan-nudge-counts-readonly-bash): в `ses_mvphq4s8` (итерация 6) харнесс
 * сказал «Ты сделал(а) 2 вызова, изменяющих файлы, без плана» после `docker ps`
 * и `ls` — счётчик мутаций рос на любой `bash`. Агент создал план, которого
 * задача не требовала, и полхода потратил на его бухгалтерию.
 */
import { describe, expect, it } from "vitest";
import { bashMutatesFiles } from "../../../src/modules/execution/bash-mutation";

/** Реальные команды из ses_mvphq4s8 — все read-only. */
const READ_ONLY = [
  "docker ps -a --format \"{{.Names}} | {{.Status}}\"",
  "docker logs lampac --tail 60",
  "docker exec lampac wget -qS -O /dev/null http://127.0.0.1:9118/sisi",
  "ls -la /tmp",
  "cat config/init.conf",
  "grep -n \"sisi\" base.conf",
  "git status",
  "git log --oneline -5",
  "git diff HEAD~1",
  "npm ls --depth=0",
  "bun test tests/core",
  "find . -name '*.ts' -newer package.json",
  "echo hello",
  "sed -n 360,430p current.conf",
  "curl -s http://127.0.0.1:9118/version",
];

const MUTATING = [
  "docker cp lampac:/lampac/current.conf ./current.conf",
  "docker compose up -d",
  "docker build -t x .",
  "git commit -m \"fix\"",
  "git checkout -b feat/x",
  "npm install",
  "bun add zod",
  "mkdir research",
  "cp a b",
  "rm /tmp/x",
  "touch marker.txt",
  "echo hi > out.txt",
  "grep -n x base.conf >> notes.md",
  "sed -i 's/a/b/' base.conf",
  "tar -xzf a.tar.gz",
  "unzip a.zip",
  "python3 build.py",
  "node scripts/gen.js",
];

describe("bash-мутации", () => {
  it.each(READ_ONLY)("read-only: %s", (cmd) => {
    expect(bashMutatesFiles(cmd)).toBe(false);
  });

  it.each(MUTATING)("мутация: %s", (cmd) => {
    expect(bashMutatesFiles(cmd)).toBe(true);
  });

  it("редирект внутри кавычек — не запись", () => {
    expect(bashMutatesFiles(`grep -o "a>b" file.txt`)).toBe(false);
    expect(bashMutatesFiles(`docker ps --format "{{.Names}} > {{.Image}}"`)).toBe(false);
  });

  it("дубли дескрипторов — не запись в файл", () => {
    expect(bashMutatesFiles("ls -la 2>&1")).toBe(false);
    expect(bashMutatesFiles("docker logs lampac >&2")).toBe(false);
  });

  it("незнакомая команда считается мутацией (fail-open)", () => {
    expect(bashMutatesFiles("weird-tool --go")).toBe(true);
  });
});
