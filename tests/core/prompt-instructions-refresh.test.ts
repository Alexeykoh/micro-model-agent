import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../../src/config/defaults";
import { loadAgentsMdBlocks } from "../../src/core/bootstrap/state";
import {
  buildSystemPrompt,
  resolvePromptOverflowOnce,
  type PromptPhaseHost,
} from "../../src/core/agent/prompt-phase";
import { diffPrompt, buildPromptSnapshot } from "../../src/core/agent/prefix-monitor";
import { refreshInstructionBlocks } from "../../src/core/prompt-instructions";
import type { AgentDeps } from "../../src/core/agent";
import { instructionsEntry } from "../../src/core/session-log-messages";

/**
 * AGENTS.md — живой источник инструкций, но системный промпт имутабелен внутри
 * хода (как карта проекта, `system-prompt-freeze.test.ts`). Новый текст должен
 * приезжать на ГРАНИЦЕ ХОДА и заменять system на месте, не добавляя запись
 * в историю.
 */

const dirs: string[] = [];

function hostWith(baseDir: string): { host: PromptPhaseHost; deps: AgentDeps } {
  const deps = {
    config: {
      ...structuredClone(DEFAULTS),
      contextWindow: 100_000,
      instructions: { summarize: false },
    },
    baseDir,
    configDir: baseDir,
    promptBlocks: loadAgentsMdBlocks(baseDir, baseDir, false),
    logger: { warn: () => undefined, debug: () => undefined },
    llmProvider: { countTokens: (s: string) => Math.ceil(s.length / 4) },
    pluginManager: { runOnBuildPrompt: () => [] },
  } as unknown as AgentDeps;
  return {
    deps,
    host: {
      deps,
      promptOverrides: new Map(),
      overflowHintBlock: null,
      frozenMapBlock: null,
    },
  };
}

function writeAgents(dir: string, marker: string): void {
  writeFileSync(join(dir, "AGENTS.md"), `# Instructions\n\nMarker: ${marker}\n`, "utf-8");
}

function promptSnapshot(host: PromptPhaseHost) {
  const built = buildSystemPrompt(host).prompt;
  return buildPromptSnapshot([{ role: "system", content: built }], []);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("AGENTS.md: обновление на границе хода", () => {
  it("keeps the system prompt byte-identical when AGENTS.md changes mid-turn", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-agents-md-"));
    dirs.push(dir);
    writeAgents(dir, "v1");
    const { host } = hostWith(dir);

    const first = buildSystemPrompt(host).prompt;
    writeAgents(dir, "v2");
    const second = buildSystemPrompt(host).prompt;

    expect(second).toBe(first);
    const countTokens = (s: string) => Math.ceil(s.length / 4);
    expect(diffPrompt(promptSnapshot(host), promptSnapshot(host), countTokens).cause).toBe("none");
  });

  it("picks up the new text at the turn boundary via in-place replacement", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-agents-md-"));
    dirs.push(dir);
    writeAgents(dir, "v1");
    const { host, deps } = hostWith(dir);

    const before = promptSnapshot(host);
    writeAgents(dir, "v2");
    // Граница хода: turn-run.ts пересобирает инструкции.
    const refreshed = refreshInstructionBlocks(deps.baseDir, deps.configDir, deps.promptBlocks);
    expect(refreshed.changed).toBe(true);
    deps.promptBlocks = refreshed.blocks;

    const after = promptSnapshot(host);
    expect(buildSystemPrompt(host).prompt).toContain("Marker: v2");
    expect(buildSystemPrompt(host).prompt).not.toContain("Marker: v1");
    const countTokens = (s: string) => Math.ceil(s.length / 4);
    expect(diffPrompt(before, after, countTokens).cause).not.toBe("none");
  });

  it("drops stale summarized overrides when AGENTS.md shrinks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-agents-md-"));
    dirs.push(dir);
    writeAgents(dir, "short");
    const { host } = hostWith(dir);

    // Замещение от прежнего (большого) AGENTS.md, которое больше не актуально.
    host.promptOverrides.set("instructions", {
      source: "agents-md",
      label: "instructions",
      content: "STALE SUMMARY",
      kind: "instructions",
      priority: "high",
      essential: false,
      estimatedTokens: 10,
    });

    await resolvePromptOverflowOnce(host);

    // Главное: прежняя сжатая замена больше не применяется, даже если для
    // нового текста резолвер создал свою замену.
    expect(buildSystemPrompt(host).prompt).not.toContain("STALE SUMMARY");
    expect(
      [...host.promptOverrides.values()].some((b) => b.content.includes("STALE SUMMARY")),
    ).toBe(false);
  });

  it("emits a structured event with source names but no file contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-agents-md-"));
    dirs.push(dir);
    writeAgents(dir, "v1");
    const { deps } = hostWith(dir);

    writeAgents(dir, "v2");
    const refreshed = refreshInstructionBlocks(deps.baseDir, deps.configDir, deps.promptBlocks);
    expect(refreshed.changed).toBe(true);
    expect(refreshed.fingerprint).not.toBe("");
    expect(refreshed.changes).toEqual([{ label: "instructions", action: "changed" }]);

    const entry = instructionsEntry({
      fingerprint: refreshed.fingerprint,
      changes: refreshed.changes,
    });
    expect(entry.type).toBe("instructions_updated");
    expect(JSON.stringify(entry)).not.toContain("Marker: v2");
  });

  it("picks up an AGENTS.md created after bootstrap (and honours --no-agents-md)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-agents-md-"));
    dirs.push(dir);
    const { deps } = hostWith(dir);
    expect(deps.promptBlocks.some((b) => b.kind === "instructions")).toBe(false);

    writeAgents(dir, "late");
    expect(
      refreshInstructionBlocks(deps.baseDir, deps.configDir, deps.promptBlocks, deps.config, true)
        .changed,
    ).toBe(false);

    const refreshed = refreshInstructionBlocks(
      deps.baseDir,
      deps.configDir,
      deps.promptBlocks,
      deps.config,
    );
    expect(refreshed.changed).toBe(true);
    expect(refreshed.changes).toEqual([{ label: "instructions", action: "added" }]);
    expect(refreshed.blocks.some((b) => b.content.includes("Marker: late"))).toBe(true);
  });

  it("substitutes each over-budget source with a truncated view, not a full copy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-agents-md-"));
    dirs.push(dir);
    mkdirSync(join(dir, "docs"), { recursive: true });
    const big =
      `# docs\n\nMARKER_DOCS_BIGFILE\n\nПовтори этот блок текста много раз для проверки: ` +
      "пример кириллицы и правило переполнения. ".repeat(1200);
    writeFileSync(join(dir, "AGENTS.md"), "# Root\n", "utf-8");
    writeFileSync(join(dir, "docs", "AGENTS.md"), big, "utf-8");
    const { host, deps } = hostWith(dir);

    await resolvePromptOverflowOnce(host);

    const label = "instructions (docs/)";
    expect(host.promptOverrides.has(label)).toBe(true);
    const view = host.promptOverrides.get(label)!;
    expect(view.estimatedTokens).toBeLessThan(
      Math.floor(deps.config.contextWindow * deps.config.contextBudget.systemPrompt),
    );
    expect(view.content).toContain("MARKER_DOCS_BIGFILE");
    expect(view.content.length).toBeLessThan(big.length);
  });

  it("reports no change when AGENTS.md is untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-agents-md-"));
    dirs.push(dir);
    writeAgents(dir, "v1");
    const { deps } = hostWith(dir);

    const refreshed = refreshInstructionBlocks(deps.baseDir, deps.configDir, deps.promptBlocks);
    expect(refreshed.changed).toBe(false);
    expect(refreshed.blocks).toBe(deps.promptBlocks);
  });
});
