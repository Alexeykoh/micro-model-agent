// Звуковые сигналы веб-UI: чистые правила переходов и настроек.
// См. docs/specs/2026-10-31-webui-sounds-design.md (INV-S1…S5).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOUND_PREFS,
  MIN_GAP_MS,
  SAME_CUE_GAP_MS,
  cueForTransition,
  notifyTabStatus,
  resolveSoundPrefs,
  shouldEmit,
} from "../src/modules/webui/assets/js/sounds.js";
import { settings } from "../src/modules/webui/assets/js/store.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ON = { enabled: true, done: true, question: true, failed: true };

describe("webui sounds: prefs", () => {
  it("falls back to defaults for missing or garbage values (INV-S5)", () => {
    expect(resolveSoundPrefs(undefined)).toEqual(DEFAULT_SOUND_PREFS);
    expect(resolveSoundPrefs(null)).toEqual(DEFAULT_SOUND_PREFS);
    expect(resolveSoundPrefs("nope")).toEqual(DEFAULT_SOUND_PREFS);
    expect(resolveSoundPrefs({ enabled: "yes", done: 1 })).toEqual(DEFAULT_SOUND_PREFS);
    expect(DEFAULT_SOUND_PREFS.enabled).toBe(false);
  });

  it("keeps explicit booleans, including a disabled event", () => {
    expect(resolveSoundPrefs({ enabled: true, done: false })).toEqual({
      enabled: true,
      done: false,
      question: true,
      failed: true,
    });
  });
});

describe("webui sounds: transitions (INV-S1/S2)", () => {
  it("maps only real transitions to cues", () => {
    expect(cueForTransition("working", "idle", ON)).toBe("done");
    expect(cueForTransition("working", "waiting", ON)).toBe("question");
    expect(cueForTransition("queued", "waiting", ON)).toBe("question");
    expect(cueForTransition("working", "failed", ON)).toBe("failed");
    expect(cueForTransition("waiting", "failed", ON)).toBe("failed");
  });

  it("stays silent without a real transition", () => {
    expect(cueForTransition("idle", "idle", ON)).toBeNull();
    expect(cueForTransition("working", "working", ON)).toBeNull();
    expect(cueForTransition("queued", "idle", ON)).toBeNull();
    expect(cueForTransition("idle", "working", ON)).toBeNull();
    expect(cueForTransition("idle", "queued", ON)).toBeNull();
    expect(cueForTransition("dead", "idle", ON)).toBeNull();
    expect(cueForTransition("working", "dead", ON)).toBeNull();
    expect(cueForTransition(undefined, "idle", ON)).toBeNull();
  });

  it("honours the master switch and per-event flags (INV-S3)", () => {
    const off = { ...ON, enabled: false };
    expect(cueForTransition("working", "idle", off)).toBeNull();
    expect(cueForTransition("working", "waiting", off)).toBeNull();
    expect(cueForTransition("working", "failed", off)).toBeNull();

    expect(cueForTransition("working", "idle", { ...ON, done: false })).toBeNull();
    expect(cueForTransition("working", "waiting", { ...ON, question: false })).toBeNull();
    expect(cueForTransition("working", "failed", { ...ON, failed: false })).toBeNull();
  });
});

describe("webui sounds: throttling", () => {
  it("gates rapid and repeated cues but lets different ones through", () => {
    expect(shouldEmit(10_000, null, "done")).toBe(true);
    expect(shouldEmit(10_000 + MIN_GAP_MS - 1, { at: 10_000, cue: "done" }, "failed")).toBe(false);
    expect(shouldEmit(10_000 + MIN_GAP_MS, { at: 10_000, cue: "done" }, "failed")).toBe(true);
    expect(shouldEmit(10_000 + SAME_CUE_GAP_MS - 1, { at: 10_000, cue: "done" }, "done")).toBe(false);
    expect(shouldEmit(10_000 + SAME_CUE_GAP_MS, { at: 10_000, cue: "done" }, "done")).toBe(true);
  });
});

describe("webui sounds: wiring", () => {
  it("reads live config and coalesces immediate duplicates", () => {
    const previous = settings.config;
    try {
      settings.config = { ui: { sounds: { enabled: false } } };
      expect(notifyTabStatus("working", "idle")).toBeNull();

      settings.config = { ui: { sounds: { enabled: true } } };
      expect(notifyTabStatus("working", "idle")).toBe("done");
      // Тот же сигнал в пределах SAME_CUE_GAP_MS — подавлен.
      expect(notifyTabStatus("working", "idle")).toBeNull();
    } finally {
      settings.config = previous;
    }
  });

  it("both tab-status paths go through the notifier (INV-S1)", () => {
    const source = readFileSync(
      resolve(REPO_ROOT, "src/modules/webui/assets/js/session/tabs.ts"),
      "utf8",
    );
    const calls = source.match(/notifyTabStatus\s*\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});
