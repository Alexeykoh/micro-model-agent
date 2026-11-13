/**
 * Daemon wire protocol (P1 monolith split, wave -1): versioning + token.
 * The daemon (`mma serve`) serves the Host surface over HTTP+SSE;
 * UI clients are thin. Token lives in OS keychain (external) or in the
 * fallback file `~/.mma/daemon.token` (0600).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PROTOCOL_VERSION = "1";

export function protocolMajor(version: string): string {
  return version.split(".")[0] ?? version;
}

export function protocolCompatible(serverVersion: string): boolean {
  return protocolMajor(serverVersion) === protocolMajor(PROTOCOL_VERSION);
}

export function defaultTokenFile(): string {
  return process.env.MMA_DAEMON_TOKEN_FILE ?? join(homedir(), ".mma", "daemon.token");
}

/** Read daemon token (env wins, then file). Null = loopback no-auth mode. */
export function readDaemonToken(tokenFile = defaultTokenFile()): string | null {
  const env = process.env.MMA_DAEMON_TOKEN ?? process.env.MMA_SERVICE_TOKEN;
  if (env) return env;
  if (!existsSync(tokenFile)) return null;
  try {
    const raw = readFileSync(tokenFile, "utf-8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

export function writeDaemonToken(token: string, tokenFile = defaultTokenFile()): void {
  mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile, `${token}\n`, { encoding: "utf-8", mode: 0o600 });
}

/** Генерирует новый токен, пишет его в файл и возвращает значение. */
export function rotateDaemonToken(tokenFile = defaultTokenFile()): string {
  const token = randomBytes(32).toString("hex");
  writeDaemonToken(token, tokenFile);
  return token;
}

/** Thin UI client: talks to the daemon over the wire (no in-process Host). */
export class DaemonClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string | null,
  ) {}

  async health(): Promise<{ status: string; protocol?: string }> {
    const res = await fetch(`${this.baseUrl}/v1/health`, { signal: AbortSignal.timeout(5_000) });
    const body = (await res.json()) as { status: string; protocol?: string };
    if (body.protocol && !protocolCompatible(body.protocol)) {
      throw new Error(
        `daemon protocol ${body.protocol} incompatible with client ${PROTOCOL_VERSION}`,
      );
    }
    return body;
  }

  async oversight(): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/v1/oversight`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 401) throw new Error("daemon unauthorized (token revoked or missing)");
    return res.json();
  }
}
