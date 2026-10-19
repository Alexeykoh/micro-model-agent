/**
 * Детектор машины: имя компьютера, имя пользователя, переменные окружения.
 * Значения получаем value-based из `PolicyContext`, плюс распознаём присваивания
 * чувствительных env-ключей прямо в тексте.
 */
import type { PolicyContext } from "../context";
import type { Finding } from "../types";
import { excludedRanges, findAll, overlapsAny } from "../normalize";

/** Env-ключи, чьи значения считаем машинными. */
const SENSITIVE_ENV_KEYS = new Set([
  "COMPUTERNAME",
  "USERNAME",
  "USER",
  "USERDOMAIN",
  "USERPROFILE",
  "HOMEPATH",
  "HOMEDRIVE",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "PWD",
  "LOGONSERVER",
  "SESSIONNAME",
  "PROCESSOR_IDENTIFIER",
  "WSL_DISTRO_NAME",
]);

const ENV_ASSIGN_RE = /\b([A-Z][A-Z0-9_]{2,})\s*=\s*([^\s"'`;]+)/g;

/** Значения машины, встречающиеся в тексте (hostname/username). */
function valueFindings(text: string, ctx: PolicyContext, excluded: ReturnType<typeof excludedRanges>): Finding[] {
  const items: Array<{ value: string; kind: string }> = [];
  if (ctx.hostname && ctx.hostname.length > 2) items.push({ value: ctx.hostname, kind: "hostname" });
  if (ctx.username && ctx.username.length > 1) items.push({ value: ctx.username, kind: "username" });
  if (ctx.platform) items.push({ value: ctx.platform, kind: "platform" });
  if (ctx.arch) items.push({ value: ctx.arch, kind: "arch" });

  const norm = text.toLowerCase();
  const findings: Finding[] = [];
  for (const { value, kind } of items) {
    for (const [start, end] of findAll(norm, value.toLowerCase())) {
      if (overlapsAny(start, end, excluded)) continue;
      findings.push({ dataClass: "machine", kind, start, end, confidence: 0.9, redact: true });
    }
  }
  return findings;
}

/** Все находки класса `machine` + `env`. */
export function detectMachine(text: string, ctx: PolicyContext): Finding[] {
  const excluded = excludedRanges(text);
  const findings = valueFindings(text, ctx, excluded);

  // Значения известных env-переменных.
  const env = ctx.env ?? {};
  for (const [key, value] of Object.entries(env)) {
    if (!SENSITIVE_ENV_KEYS.has(key) || !value || value.length < 3) continue;
    for (const [start, end] of findAll(text, value)) {
      if (overlapsAny(start, end, excluded)) continue;
      findings.push({ dataClass: "env", kind: `env:${key}`, start, end, confidence: 0.85, redact: true });
    }
  }

  // Присваивания чувствительных ключей прямо в тексте.
  ENV_ASSIGN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENV_ASSIGN_RE.exec(text)) !== null) {
    if (!SENSITIVE_ENV_KEYS.has(m[1])) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (overlapsAny(start, end, excluded)) continue;
    findings.push({ dataClass: "env", kind: `env:${m[1]}`, start, end, confidence: 0.8, redact: true });
  }

  return findings;
}
