/**
 * `/v1/host/memory` и `/v1/host/skills` — read-only панели (split W4b-2b).
 *
 * Формы ответов совпадают с web (`preferences/categories`, `skills`), чтобы
 * адаптер отдавал их браузеру без пересборки.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { redactContextSecrets } from "../../../core/api";
import { listEntries, MEMORY_CATEGORIES } from "../../../runtime/memory-view";
import { sendJson } from "../http/respond";
import type { AgentServiceState } from "../state";

/** `/v1/host/memory`; `true` — запрос обработан. */
export function handleHostMemory(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  parts: string[],
): boolean {
  if (parts.length !== 3 || parts[2] !== "memory" || req.method !== "GET") return false;
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
