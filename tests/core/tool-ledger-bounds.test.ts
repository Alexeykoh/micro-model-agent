/**
 * W2.5 (§3.9): леджер тулов ограничен, вытесненные ключи освобождаются и снова
 * допускаются, а сигнатура аргументов не зависит от порядка ключей.
 */
import { describe, expect, it } from "vitest";
import { absorbLedgers, ledgerKeyFromLine, summarizeArgs } from "../../src/core/context/ledger-absorb";
import type { Message } from "../../src/core/context/message";

function toolMessage(name: string, args: Record<string, unknown>, text = "ok"): Message {
  return { role: "tool", name, content: text, arguments: args, success: true };
}

describe("tool ledger bounds", () => {
  it("sorts argument keys instead of taking insertion order", () => {
    expect(summarizeArgs({ zeta: 1, alpha: 2, mu: 3, beta: 4 })).toBe("alpha, beta, mu");
    expect(summarizeArgs({ beta: 1, alpha: 2 })).toBe(summarizeArgs({ alpha: 2, beta: 1 }));
  });

  it("keeps the ledger and its key set bounded", () => {
    const ledger: string[] = [];
    const keys = new Set<string>();
    for (let i = 0; i < 40; i++) {
      absorbLedgers([toolMessage("read_file", { [`k${i}`]: 1 })], null, true, ledger, keys);
    }
    const lastEntry = ledger.at(-1) ?? "";
    expect(ledger.length).toBeLessThanOrEqual(12);
    expect(keys.size).toBe(ledger.length);
    expect(lastEntry).toContain("k39");
  });

  it("re-admits an evicted key", () => {
    const ledger: string[] = [];
    const keys = new Set<string>();
    for (let i = 0; i < 40; i++) {
      absorbLedgers([toolMessage("read_file", { [`k${i}`]: 1 })], null, true, ledger, keys);
    }
    // k0 давно вытеснен — его ключ обязан освободиться, иначе запись не вернуть.
    expect(ledgerKeyFromLine(ledger[0] ?? "")).not.toBe("read_file:k0");
    absorbLedgers([toolMessage("read_file", { k0: 1 })], null, true, ledger, keys);
    expect(ledger.at(-1)).toContain("k0");
  });
});
