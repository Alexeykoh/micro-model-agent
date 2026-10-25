// Инсталляторы: ретраи, докачка и понятные ошибки вместо «checksum mismatch».
//
// Проверка герметичная: манифест и артефакт отдаёт локальный HTTP-сервер,
// установка идёт во временный MMA_HOME. Сценарии повторяют реальный сбой
// (оборванная загрузка на медленном канале) — до правки скрипт на них падал.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const isWin = process.platform === "win32";
const root = process.cwd();
const version = "0.0.1";
const platformKeys = ["win-x64", "win-arm64", "linux-x64", "linux-arm64", "mac-x64", "mac-arm64"];
const testTimeout = { timeout: 90000 };

type Mode = "ok" | "corrupt-once" | "truncate-once";

let workDir = "";
let artifact: Buffer;
let sha256 = "";
const homes: string[] = [];

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "mma-installer-"));
  artifact = buildArtifact();
  sha256 = createHash("sha256").update(artifact).digest("hex");
});

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  for (const home of homes) {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // Каталог может ещё держать убитый процесс-держатель — это временная папка.
    }
  }
});

/** Архив повторяет форму релиза: VERSION + app/main.js + несжимаемый padding. */
function buildArtifact(): Buffer {
  const pkg = join(workDir, "package");
  const out = join(workDir, "mma.tar.gz");
  mkdirSync(join(pkg, "app"), { recursive: true });
  writeFileSync(join(pkg, "VERSION"), `${version}\n`);
  writeFileSync(join(pkg, "app", "main.js"), "console.log('0.0.1');\n");
  writeFileSync(join(pkg, "padding.bin"), randomBytes(256 * 1024));
  const tar = spawnSync("tar", ["-czf", out, "-C", pkg, "."], { encoding: "utf8" });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  return readFileSync(out);
}

interface Harness {
  base: string;
  requests: number;
  ranges: number;
  close: () => Promise<void>;
}

function startServer(mode: Mode): Promise<Harness> {
  const state = { requests: 0, ranges: 0 };
  const sockets = new Set<Socket>();
  const manifest = {
    version,
    releasedAt: new Date().toISOString(),
    artifacts: Object.fromEntries(
      platformKeys.map((key) => [key, { url: `mma-${key}.tar.gz`, sha256, size: artifact.length }]),
    ),
  };
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/latest.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(`${JSON.stringify(manifest, null, 2)}\n`);
      return;
    }
    if (!url.startsWith("/mma-")) {
      res.writeHead(404).end();
      return;
    }
    state.requests += 1;
    if (mode === "corrupt-once" && state.requests === 1) {
      // Тот же размер, другой байт: ровно то, что даёт побитая загрузка.
      const broken = Buffer.from(artifact);
      broken[Math.floor(broken.length / 2)] ^= 0xff;
      res.writeHead(200, { "Content-Length": broken.length });
      res.end(broken);
      return;
    }
    if (mode === "truncate-once" && state.requests === 1) {
      res.writeHead(200, { "Content-Length": artifact.length, "Accept-Ranges": "bytes" });
      res.write(artifact.subarray(0, Math.floor(artifact.length / 2)), () => res.destroy());
      return;
    }
    const match = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    if (match) {
      const start = Number(match[1]);
      state.ranges += 1;
      if (start >= artifact.length) {
        res.writeHead(416).end();
        return;
      }
      res.writeHead(206, {
        "Content-Length": artifact.length - start,
        "Content-Range": `bytes ${start}-${artifact.length - 1}/${artifact.length}`,
        "Accept-Ranges": "bytes",
      });
      res.end(artifact.subarray(start));
      return;
    }
    res.writeHead(200, { "Content-Length": artifact.length, "Accept-Ranges": "bytes" });
    res.end(artifact);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        base: `http://127.0.0.1:${port}`,
        get requests() {
          return state.requests;
        },
        get ranges() {
          return state.ranges;
        },
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      } as Harness);
    });
  });
}

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "mma-install-home-"));
  homes.push(home);
  return home;
}

/** env с PATH, в который уже входит bin: установщик не должен править rc/реестр. */
function envWithPath(values: Record<string, string | undefined>, pathValue: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries({ ...process.env, ...values })) {
    if (key.toLowerCase() !== "path") env[key] = value;
  }
  env.PATH = pathValue;
  return env;
}

/**
 * Запуск установщика без блокировки event loop: сервер герметичной проверки
 * живёт в этом же процессе и иначе не успел бы ответить (spawnSync мёртво
 * держит loop).
 */
function runProcess(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, env });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill(), 120000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: -1, stdout: String(err) });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout: output });
    });
  });
}

interface InstallOutcome {
  status: number | null;
  stdout: string;
  requests: number;
  ranges: number;
  home: string;
}

async function installWith(
  cmd: string,
  args: string[],
  mode: Mode,
  sep: string,
  existingHome?: string,
): Promise<InstallOutcome> {
  const harness = await startServer(mode);
  const home = existingHome ?? freshHome();
  const values: Record<string, string> = {
    MMA_INSTALL_BASE: harness.base,
    MMA_HOME: home,
    HOME: join(home, "home"),
    MMA_INSTALL_DRY_RUN: "0",
  };
  const res = await runProcess(
    cmd,
    args,
    envWithPath(values, `${join(home, "bin")}${sep}${process.env.PATH ?? ""}`),
  );
  const outcome = {
    status: res.status,
    stdout: res.stdout,
    requests: harness.requests,
    ranges: harness.ranges,
    home,
  };
  await harness.close();
  return outcome;
}

function assertInstalled(home: string): void {
  const marker = join(home, "versions", version, "VERSION");
  expect(statSync(marker, { throwIfNoEntry: false })?.isFile()).toBe(true);
  expect(readFileSync(marker, "utf8").trim()).toBe(version);
  const current = readlinkSync(join(home, "current")).replace(/^\\\\\?\\/, "");
  expect(current).toContain(join("versions", version));
}

describe("installer sources", () => {
  it("install.ps1 is ASCII-only", () => {
    // Windows PowerShell 5.1 reads a BOM-less script as ANSI: one non-ASCII
    // byte (Cyrillic comment, typographic dash) breaks parsing after `irm | iex`.
    const bytes = readFileSync(join(root, "scripts", "install.ps1"));
    const offenders: string[] = [];
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] > 0x7f) offenders.push(`offset ${i}: 0x${bytes[i].toString(16)}`);
    }
    expect(offenders.slice(0, 5)).toEqual([]);
  });
});

/** Один и тот же сценарий для PowerShell 5.1 и 7: оба должны работать. */
function ps1Suite(shell: string): () => void {
  return () => {
    const install = (mode: Mode, home?: string): Promise<InstallOutcome> =>
      installWith(
        shell,
        ["-NoProfile", "-File", join(root, "scripts", "install.ps1")],
        mode,
        ";",
        home,
      );

    it("ставит релиз с первого раза", testTimeout, async () => {
      const res = await install("ok");
      expect(res.status, res.stdout).toBe(0);
      expect(res.stdout).toContain(`installed MMA ${version}`);
      expect(res.requests).toBe(1);
      assertInstalled(res.home);
      const launcher = readFileSync(join(res.home, "bin", "mma.cmd"), "utf8");
      expect(launcher).toContain("current\\runtime\\bun.exe");
      expect(launcher).toContain("current\\app\\main.js");
    });

    it("перекачивает побитый файл вместо падения на checksum mismatch", testTimeout, async () => {
      const res = await install("corrupt-once");
      expect(res.status, res.stdout).toBe(0);
      expect(res.stdout).toContain("checksum mismatch: discarding the download and retrying");
      expect(res.stdout).toContain(`installed MMA ${version}`);
      expect(res.requests).toBe(2);
      assertInstalled(res.home);
    });

    it("докачивает оборванную загрузку с места обрыва", testTimeout, async () => {
      const res = await install("truncate-once");
      expect(res.status, res.stdout).toBe(0);
      // Докачка запрошена (Range), а испорченный хвост не дошёл до установки.
      expect(res.ranges).toBeGreaterThanOrEqual(1);
      expect(res.requests).toBeGreaterThanOrEqual(2);
      expect(res.stdout).not.toContain("could not download");
      assertInstalled(res.home);
    });

    it("не удаляет версию, из которой сейчас работает MMA", testTimeout, async () => {
      const first = await install("ok");
      expect(first.status, first.stdout).toBe(0);
      const liveDir = join(first.home, "versions", version);
      // Процесс с cwd внутри версии — тот же Windows-лок, что и запущенный bun.exe.
      const holder = spawn(
        "cmd.exe",
        ["/c", `echo started> marker.txt & ping -n 30 127.0.0.1 >nul`],
        { cwd: liveDir, stdio: "ignore", windowsHide: true },
      );
      try {
        const marker = join(liveDir, "marker.txt");
        for (let i = 0; i < 50 && !statSync(marker, { throwIfNoEntry: false }); i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(statSync(marker, { throwIfNoEntry: false })?.isFile()).toBe(true);
        const second = await install("ok", first.home);
        expect(second.status, second.stdout).toBe(1);
        expect(second.stdout).toContain("is in use; close MMA");
        // Активная версия осталась цела: провал не должен ломать установку.
        assertInstalled(first.home);
      } finally {
        holder.kill();
      }
    });
  };
}

describe.skipIf(!isWin)("install.ps1 (pwsh)", ps1Suite("pwsh"));
describe.skipIf(!isWin)("install.ps1 (powershell.exe)", ps1Suite("powershell.exe"));

describe.skipIf(isWin)("install.sh", () => {
  const install = (mode: Mode): Promise<InstallOutcome> =>
    installWith("sh", [join(root, "scripts", "install.sh")], mode, ":");

  it("ставит релиз с первого раза", testTimeout, async () => {
    const res = await install("ok");
    expect(res.status, res.stdout).toBe(0);
    expect(res.stdout).toContain(`installed MMA ${version}`);
    expect(res.requests).toBe(1);
    assertInstalled(res.home);
  });

  it("перекачивает побитый файл вместо падения на checksum mismatch", testTimeout, async () => {
    const res = await install("corrupt-once");
    expect(res.status, res.stdout).toBe(0);
    expect(res.stdout).toContain("checksum mismatch: discarding the download and retrying");
    expect(res.requests).toBe(2);
    assertInstalled(res.home);
  });

  it("докачивает оборванную загрузку с места обрыва", testTimeout, async () => {
    const res = await install("truncate-once");
    expect(res.status, res.stdout).toBe(0);
    expect(res.ranges).toBeGreaterThanOrEqual(1);
    expect(res.requests).toBeGreaterThanOrEqual(2);
    expect(res.stdout).not.toContain("could not download");
    assertInstalled(res.home);
  });
});
