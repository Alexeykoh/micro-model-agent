/**
 * `/v1/host/memory` и `/v1/host/skills` — read-only панели (split W4b-2b).
 *
 * Формы ответов совпадают с web (`preferences/categories`, `skills`), чтобы
 * адаптер отдавал их браузеру без пересборки.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { redactContextSecrets } from "../../../core/api";
import {
  isMemoryCategory,
  listEntries,
  MAX_MEMORY_ENTRY_CHARS,
  MEMORY_CATEGORIES,
} from "../../../runtime/memory-view";
import { readJsonBodyOrProblem, sendJson } from "../http/respond";
import type { AgentServiceState } from "../state";

const MAX_JSON_BYTES = 1024 * 1024;

/** `/v1/host/memory[/:category/:n]`; `true` — запрос обработан. */
export async function handleHostMemory(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  parts: string[],
): Promise<boolean> {
  if (parts[2] !== "memory") return false;
  if (parts.length === 3 && req.method === "GET") return memoryGet(res, s);
  if (parts.length === 3 && req.method === "POST") return memoryPost(req, res, s);
  if (parts.length === 5 && req.method === "DELETE") {
    return memoryDelete(res, s, decodeURIComponent(parts[3]), decodeURIComponent(parts[4]));
  }
  return false;
}

/** `GET /v1/host/memory` — преференции + записи (секреты вычищены). */
function memoryGet(res: ServerResponse, s: AgentServiceState): boolean {
  const store = s.deps.memory;
  if (!store) {
    sendJson(res, 503, { error: "memory_unavailable" });
    return true;
  }
  const preferences: Record<string, string> = {};
  for (const [key, value] of Object.entries(store.getPreferences())) {
    preferences[key] = redactContextSecrets(String(value));
  }
  const categories = MEMORY_CATEGORIES.map((name) => ({
    name,
    entries: listEntries(store.read(name)).map((e) => ({
      n: e.n,
      text: redactContextSecrets(e.text),
    })),
  }));
  sendJson(res, 200, { preferences, categories });
  return true;
}

/** `POST /v1/host/memory {category, text}` — дописать запись. */
async function memoryPost(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
): Promise<boolean> {
  const store = s.deps.memory;
  if (!store) {
    sendJson(res, 503, { error: "memory_unavailable" });
    return true;
  }
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const category = typeof body.category === "string" ? body.category : "";
  const rawText = typeof body.text === "string" ? body.text.trim() : "";
  if (!isMemoryCategory(category) || rawText.length === 0) {
    sendJson(res, 400, { ok: false, error: "invalid-entry" });
    return true;
  }
  store.append(category, rawText.slice(0, MAX_MEMORY_ENTRY_CHARS));
  sendJson(res, 200, {
    ok: true,
    ...(rawText.length > MAX_MEMORY_ENTRY_CHARS ? { truncated: true } : {}),
  });
  return true;
}

/** `DELETE /v1/host/memory/:category/:n` — забыть n-ю запись. */
function memoryDelete(
  res: ServerResponse,
  s: AgentServiceState,
  category: string,
  nRaw: string,
): boolean {
  const store = s.deps.memory;
  if (!store) {
    sendJson(res, 503, { error: "memory_unavailable" });
    return true;
  }
  if (!isMemoryCategory(category)) {
    sendJson(res, 400, { ok: false, error: "invalid-category" });
    return true;
  }
  const n = parseInt(nRaw, 10);
  if (!(n > 0) || !store.deleteEntry(category, n)) {
    sendJson(res, 404, { ok: false, error: "not_found" });
    return true;
  }
  sendJson(res, 200, { ok: true });
  return true;
}

/** `/v1/host/skills`; `true` — запрос обработан. */
export function handleHostSkills(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  parts: string[],
): boolean {
  if (parts.length !== 3 || parts[2] !== "skills" || req.method !== "GET") return false;
  const skills = s.deps.skills;
  if (!skills) {
    sendJson(res, 503, { error: "skills_unavailable" });
    return true;
  }
  const loaded = new Set(skills.getLoaded().map((skill) => skill.name));
  sendJson(res, 200, {
    skills: skills.getAvailable().map((skill) => {
      const info: Record<string, unknown> = { name: skill.name, enabled: loaded.has(skill.name) };
      if (skill.kind) info.kind = skill.kind;
      if (skill.description) info.description = skill.description;
      if (skill.sourcePath) info.source = skill.sourcePath;
      return info;
    }),
  });
  return true;
}
