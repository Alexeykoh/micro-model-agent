import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSpec } from "../src/utils/spawn-command";
import { spawnEnv, spawnEnvPath } from "../src/modules/mcp/stdio-spawn";
import { MCPClient } from "../src/modules/mcp/client";

describe("spawnSpec", () => {
  let tmp = "";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-spawn-"));
  });

  afterEach(() => {
    try {
      if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it("leaves command and args untouched on non-Windows", () => {
    const spec = spawnSpec("npx", ["-y", "@playwright/mcp@latest"], "linux", "");
    expect(spec).toEqual({ command: "npx", args: ["-y", "@playwright/mcp@latest"], shell: false });
  });

  it("routes a bare .cmd shim through the shell on Windows", () => {
    writeFileSync(join(tmp, "npx.cmd"), "@echo off", "utf-8");
    const spec = spawnSpec("npx", ["--version"], "win32", tmp);
    expect(spec).toEqual({ command: "npx.cmd --version", args: [], shell: true });
  });

  it("routes an explicit .cmd path through the shell on Windows", () => {
    const shim = join(tmp, "server.cmd");
    writeFileSync(shim, "@echo off", "utf-8");
    expect(spawnSpec(shim, [], "win32", tmp)).toEqual({
      command: shim,
      args: [],
      shell: true,
    });
  });

  it("spawns .exe directly on Windows (no shell)", () => {
    writeFileSync(join(tmp, "tool.exe"), "", "utf-8");
    expect(spawnSpec("tool", ["a"], "win32", tmp)).toEqual({
      command: "tool.exe",
      args: ["a"],
      shell: false,
    });
  });
});

describe("spawnEnvPath / spawnEnv", () => {
  it("prefers the configured env, then Windows `Path` over a POSIX `PATH`", () => {
    const posix = "/c/Users/x:/usr/bin";
    const win = "C:\\Temp\\shim;C:\\Windows";
    // git-bash: `PATH` — POSIX-форма, `Path` — исходная Windows-форма.
    expect(spawnEnvPath({ PATH: posix, Path: win }, undefined, "win32")).toBe(win);
    expect(spawnEnvPath({ PATH: posix }, undefined, "win32")).toBe(posix);
    // Явный env из конфига главнее процесса (в любой форме).
    expect(spawnEnvPath({ PATH: posix, Path: win }, { Path: "C:\\cfg" }, "win32")).toBe("C:\\cfg");
    expect(spawnEnvPath({ PATH: posix, Path: win }, { PATH: "/cfg" }, "win32")).toBe("/cfg");
    expect(spawnEnvPath({ PATH: "/usr/bin" }, undefined, "linux")).toBe("/usr/bin");
  });

  it("keeps exactly one PATH key on Windows (cmd.exe takes the first one)", () => {
    const win = "C:\\Temp\\shim;C:\\Windows";
    const { env, pathEnv } = spawnEnv({ PATH: "/c/posix", Path: win, HOME: "x" }, undefined, "win32");
    expect(pathEnv).toBe(win);
    expect(env.Path).toBe(win);
    expect(env.PATH).toBeUndefined();
    expect(env.HOME).toBe("x");
  });

  it("leaves the env alone on non-Windows", () => {
    const { env, pathEnv } = spawnEnv({ PATH: "/usr/bin", Path: "/legacy" }, undefined, "linux");
    expect(pathEnv).toBe("/usr/bin");
    expect(env).toEqual({ PATH: "/usr/bin", Path: "/legacy" });
  });
});

describe("MCPClient stdio spawn through a platform shim", () => {
  // Fake MCP server: answers initialize + tools/list over JSON-RPC/NDJSON.
  const SERVER_SCRIPT = `
    let buf = "";
    process.stdin.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } }) + "\\n");
        } else if (msg.method === "tools/list") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "Echo" }] } }) + "\\n");
        }
      }
    });
  `;

  let tmp = "";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mcp-shim-"));
  });

  afterEach(() => {
    try {
      if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it("connects and lists tools when the command is a bare name resolved to a .cmd/.sh shim", async () => {
    const server = join(tmp, "server.js");
    writeFileSync(server, SERVER_SCRIPT, "utf-8");

    // Конфиг MCP-сервера обычно задаёт голое имя (`npx`), а на Windows это
    // `.cmd`-шим на PATH. Раньше прямой `spawn("npx")` падал с ENOENT, и все
    // MCP-тулы молча исчезали из набора (сессия ses_mvvecf8h_jywzvafgprkybqey).
    const isWin = process.platform === "win32";
    const shim = join(tmp, isWin ? "probe-mcp.cmd" : "probe-mcp");
    writeFileSync(
      shim,
      isWin
        ? `@echo off\r\n"${process.execPath}" "${server}"\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${server}"\n`,
      "utf-8",
    );
    if (!isWin) chmodSync(shim, 0o755);

    const envPath = `${tmp}${isWin ? ";" : ":"}${process.env.PATH ?? ""}`;
    // Windows в env-объекте отдаёт ключ `Path`, а не `PATH`.
    const client = new MCPClient({
      name: "probe",
      command: "probe-mcp",
      args: [],
      transport: "stdio",
      env: isWin ? { Path: envPath } : { PATH: envPath },
    });
    try {
      await client.connect();
      expect(client.isConnected()).toBe(true);
      const tools = await client.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("echo");
    } finally {
      await client.disconnect();
    }
  }, 20000);
});
