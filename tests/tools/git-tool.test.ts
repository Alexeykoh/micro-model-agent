import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitTool } from "../../src/tools/git";
import { runGit } from "../../src/tools/git-core";
import { ApprovalStore } from "../../src/core/approvals";

/**
 * Тул `git` (спека 2026-08-07-git-workflow §5): argv-исполнение,
 * мемо read-класс, destructive — только по разрешению approve, jail-флаги.
 * Тесты гоняют НАСТОЯЩИЙ git во временных репозиториях (git есть в CI —
 * репозиторий проекта сам git-рабочее дерево).
 */

type Ctx = Parameters<typeof gitTool.handler>[0];

interface Memo {
  store: Map<string, unknown>;
  invalidate: () => void;
}

function makeCtx(baseDir: string, opts: { approvals?: ApprovalStore; memo?: Memo; callId?: string } = {}): Ctx {
  const memo = opts.memo;
  return {
    baseDir,
    config: { security: { paths: { enabled: true, denied: [], allowed: [] } } },
    logger: { info: () => {}, error: () => {} },
    approvals: opts.approvals,
    activeCallId: opts.callId ?? "call-1",
    toolExecutor: memo
      ? {
          memoGet: (name: string, args: unknown) => memo.store.get(JSON.stringify([name, args])) as never,
          memoSet: (name: string, args: unknown, result: unknown) => void memo.store.set(JSON.stringify([name, args]), result),
          memoInvalidate: () => memo.invalidate(),
        }
      : undefined,
  } as unknown as Ctx;
}

/** Свежий репозиторий с одним коммитом `a.txt`. */
async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "mma-git-tool-"));
  expect((await runGit(dir, ["init"])).ok).toBe(true);
  await runGit(dir, ["config", "user.name", "test"]);
  await runGit(dir, ["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  expect((await runGit(dir, ["add", "a.txt"])).ok).toBe(true);
  expect((await runGit(dir, ["commit", "-m", "first"])).ok).toBe(true);
  return dir;
}

function newMemo(): Memo {
  const store = new Map<string, unknown>();
  return { store, invalidate: () => store.clear() };
}

describe("git tool: read + memo", () => {
  it("status исполняется и попадает в мемо; повтор отдаёт кеш без перезапуска", async () => {
    const dir = await makeRepo();
    const memo = newMemo();
    const ctx = makeCtx(dir, { memo });
    const first = await gitTool.handler(ctx, { subcommand: "status" });
    expect(first.success).toBe(true);
    expect(memo.store.size).toBe(1);

    // Мутация обходит мемо: пока TTL жив, повтор обязан отдать СТАРЫЙ снимок.
    writeFileSync(join(dir, "b.txt"), "dirty\n");
    const second = await gitTool.handler(ctx, { subcommand: "status" });
    expect(second.output).toBe(first.output);
    expect(second.output).not.toContain("b.txt");

    // Любая НЕ-read операция сбрасывает мемо — следующая read честная.
    const third = await gitTool.handler(ctx, { subcommand: "add", args: ["b.txt"] });
    expect(third.success).toBe(true);
    expect(memo.store.size).toBe(0);
    const after = await gitTool.handler(ctx, { subcommand: "status" });
    expect(after.output).toContain("b.txt");
    rmSync(dir, { recursive: true, force: true });
  });

  it("lines ограничивает вывод с явной отметкой усечения", async () => {
    const dir = await makeRepo();
    writeFileSync(join(dir, "a.txt"), "two\n");
    await runGit(dir, ["commit", "-am", "second"]);
    const ctx = makeCtx(dir);
    const res = await gitTool.handler(ctx, { subcommand: "log", args: ["--oneline"], lines: 1 });
    expect(res.success).toBe(true);
    expect(res.output.split("\n")[0]).toContain("second");
    expect(res.output).toContain("truncated");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("git tool: destructive и approve", () => {
  it("destructive БЕЗ разрешения не исполняется (blocked, не retry-сигнал)", async () => {
    const dir = await makeRepo();
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const ctx = makeCtx(dir, { approvals: new ApprovalStore() });
    const res = await gitTool.handler(ctx, { subcommand: "reset", args: ["--hard"] });
    expect(res.success).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.errorMeta?.code).toBe("git_destructive_needs_approval");
    expect(res.output).toContain("git reset --hard");
    // Команда НЕ выполнилась: изменения на месте.
    const dirty = await runGit(dir, ["status", "--porcelain"]);
    expect(dirty.stdout).toContain("a.txt");
    rmSync(dir, { recursive: true, force: true });
  });

  it("после approve destructive исполняется; разрешение одноразовое", async () => {
    const dir = await makeRepo();
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const approvals = new ApprovalStore();
    const res1 = await gitTool.handler(makeCtx(dir, { approvals }), { subcommand: "reset", args: ["--hard"] });
    expect(res1.blocked).toBe(true);

    approvals.grant(resolve(dir), "git reset --hard");
    const res2 = await gitTool.handler(makeCtx(dir, { approvals, callId: "call-2" }), { subcommand: "reset", args: ["--hard"] });
    expect(res2.success).toBe(true);
    const dirty = await runGit(dir, ["status", "--porcelain"]);
    expect(dirty.stdout.trim()).toBe(""); // изменения действительно сброшены

    // Тот же grant уже потреблён call-2: новый вызов снова обязан спросить.
    const res3 = await gitTool.handler(makeCtx(dir, { approvals, callId: "call-3" }), { subcommand: "reset", args: ["--hard"] });
    expect(res3.blocked).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("jail-флаг остаётся заблокированным даже после approve (защита в два слоя)", async () => {
    const dir = await makeRepo();
    const other = mkdtempSync(join(tmpdir(), "mma-git-other-"));
    const approvals = new ApprovalStore();
    approvals.grant(resolve(dir), "git -C other");
    const res = await gitTool.handler(makeCtx(dir, { approvals }), { subcommand: "-C", args: [other, "status"] });
    expect(res.success).toBe(false);
    expect(res.output).toContain("not allowed");
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });
});

describe("git tool: входные данные и ошибки", () => {
  it("subcommand с шелл-синтаксисом отвергается до запуска", async () => {
    const dir = await makeRepo();
    const ctx = makeCtx(dir);
    const res = await gitTool.handler(ctx, { subcommand: "status && del x" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("Invalid subcommand");
    rmSync(dir, { recursive: true, force: true });
  });

  it("вне репозитория — честный git_not_a_repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-git-norepo-"));
    mkdirSync(join(dir, "sub"), { recursive: true });
    const ctx = makeCtx(dir);
    const res = await gitTool.handler(ctx, { subcommand: "status" });
    expect(res.success).toBe(false);
    expect(res.errorMeta?.code).toBe("git_not_a_repo");
    rmSync(dir, { recursive: true, force: true });
  });

  it("файловый diff ограничен file-аргументом", async () => {
    const dir = await makeRepo();
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    writeFileSync(join(dir, "b.txt"), "bbb\n");
    const ctx = makeCtx(dir);
    const res = await gitTool.handler(ctx, { subcommand: "diff", file: "a.txt" });
    expect(res.success).toBe(true);
    expect(res.output).toContain("a.txt");
    expect(res.output).not.toContain("+++ b/b.txt");
    rmSync(dir, { recursive: true, force: true });
  });
});
