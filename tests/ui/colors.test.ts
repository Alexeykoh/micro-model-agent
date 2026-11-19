import { describe, it, expect, afterEach } from "vitest";

const ORIG_ENV: Record<string, string | undefined> = { ...process.env };

function setEnv(env: Record<string, string | undefined>) {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIG_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreEnv() {
  setEnv(ORIG_ENV);
}

afterEach(() => {
  restoreEnv();
  restoreTty();
});

let ttyValue: boolean | undefined;
let origTty: PropertyDescriptor | undefined;

function mockTty(value: boolean) {
  ttyValue = value;
  origTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    get: () => ttyValue,
  });
}

function restoreTty() {
  if (origTty) {
    Object.defineProperty(process.stdout, "isTTY", origTty);
    origTty = undefined;
  }
}

async function loadColors(tty: boolean, env: Record<string, string | undefined>) {
  mockTty(tty);
  setEnv(env);
  const mod = await import(`../../src/ui/colors?t=${Date.now()}-${Math.random()}`);
  return mod;
}

describe("colors", () => {
  it("disables colors outside a TTY", async () => {
    const { pc } = await loadColors(false, {});
    expect(pc.bold("x")).toBe("x");
  });

  it("disables colors in CI", async () => {
    const { pc } = await loadColors(true, { CI: "1" });
    expect(pc.bold("x")).toBe("x");
  });

  it("disables colors on NO_COLOR", async () => {
    const { pc } = await loadColors(true, { NO_COLOR: "1" });
    expect(pc.bold("x")).toBe("x");
  });

  it("enables colors on a TTY without CI/NO_COLOR", async () => {
    const { pc } = await loadColors(true, { CI: "", NO_COLOR: "" });
    expect(pc.bold("x")).toBe("\u001b[1mx\u001b[22m");
  });
});
