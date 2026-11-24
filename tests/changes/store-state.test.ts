import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changeEntry,
  changesConfig,
  createStore,
  loadChangesStoreModule,
} from "./store-test-helpers";

const { ChangesStore } = await loadChangesStoreModule();

let root: string;
let store: InstanceType<typeof ChangesStore>;

const statePath = (): string => join(store.dir("s1"), "state.json");

function writeState(content: string): void {
  mkdirSync(store.dir("s1"), { recursive: true });
  writeFileSync(statePath(), content, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mma-changes-state-"));
  store = createStore(ChangesStore, root, changesConfig(root));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ChangesStore turn state", () => {
  it("returns zero only when state is missing", () => {
    expect(store.loadTurn("s1")).toBe(0);
  });

  it("recovers corrupt JSON from the maximum journal turn", () => {
    store.append("s1", changeEntry(root, { turn: 2 }));
    store.append("s1", changeEntry(root, { turn: 7 }));
    writeState("{broken");

    expect(store.nextTurn("s1")).toBe(8);
    expect(store.loadTurn("s1")).toBe(8);
    expect(JSON.parse(readFileSync(statePath(), "utf8"))).toEqual({
      v: 1,
      turn: 8,
    });
    expect(readdirSync(store.dir("s1")).some((name) => name.includes(".tmp"))).toBe(
      false,
    );
  });

  it("recovers a wrong-version state from the journal", () => {
    store.append("s1", changeEntry(root, { turn: 4 }));
    writeState(JSON.stringify({ v: 2, turn: 99 }));
    expect(store.nextTurn("s1")).toBe(5);
  });

  it("recovers a negative-turn state from the journal", () => {
    store.append("s1", changeEntry(root, { turn: 6 }));
    writeState(JSON.stringify({ v: 1, turn: -3 }));
    expect(store.nextTurn("s1")).toBe(7);
  });

  it("recovers an undecryptable state from the journal", () => {
    const config = changesConfig(root);
    config.security!.sessionEncryption.enabled = true;
    store = createStore(ChangesStore, root, config);
    store.append("s1", changeEntry(root, { turn: 5 }));
    store.nextTurn("s1");
    writeState("AAAA:AAAA:AAAA:AAAA");

    expect(store.nextTurn("s1")).toBe(6);
    expect(store.loadTurn("s1")).toBe(6);
  });

  it("refuses to replace corrupt state when the journal has no evidence", () => {
    const corrupt = "{broken";
    writeState(corrupt);

    expect(() => store.loadTurn("s1")).toThrow(/invalid|corrupt/i);
    expect(() => store.nextTurn("s1")).toThrow(/recover|corrupt/i);
    expect(readFileSync(statePath(), "utf8")).toBe(corrupt);
  });

  it("uses journal evidence when state is missing", () => {
    store.append("s1", changeEntry(root, { turn: 9 }));
    expect(store.nextTurn("s1")).toBe(10);
  });

  it("never reuses a journal turn higher than valid state", () => {
    store.append("s1", changeEntry(root, { turn: 8 }));
    expect(store.nextTurn("s1")).toBe(9);
    store.append("s1", changeEntry(root, { turn: 10 }));
    expect(store.nextTurn("s1")).toBe(11);
  });

  it("refuses to allocate an unsafe turn number", () => {
    store.append(
      "s1",
      changeEntry(root, { turn: Number.MAX_SAFE_INTEGER }),
    );
    expect(() => store.nextTurn("s1")).toThrow(/safe|overflow/i);
  });
});
