// Мост «скиллы изменились» → SSE-событие `skills` (веб-индикатор в композере).
//
// Скиллы — процессный синглтон: загрузка в сессии A делает скилл видимым
// в промпте сессии B. Поэтому событие глобальное (без sessionId), а его
// полезная нагрузка — только безопасный вид `{name, kind}`: тело скила и
// абсолютный путь наружу не уходят (SSE не проходит через egress-фильтр).
import { broadcast, type SseTransport } from "./state";
import type { WebSkillsModule } from "./state-contracts";

/** Безопасный вид загруженного скила для SSE-пэйлоада. */
export interface SkillEventView {
  name: string;
  kind: "builtin" | "global" | "project";
}

/** Снимок текущего загруженного набора для SSE (в greeting и на изменении). */
export function skillsEventPayload(skills: WebSkillsModule | undefined): {
  type: "skills";
  ts: number;
  skills: SkillEventView[];
} {
  const loaded = skills?.getLoaded() ?? [];
  return {
    type: "skills",
    ts: Date.now(),
    skills: loaded.map((s) => ({ name: s.name, kind: (s.kind ?? "global") as SkillEventView["kind"] })),
  };
}

/** Подписать `mma web` на изменения загруженного набора; возвращает отписку. */
export function installSkillsEvents(state: SseTransport, skills: WebSkillsModule | undefined): () => void {
  if (!skills?.onChange) return () => {};
  return skills.onChange(() => {
    broadcast(skillsEventPayload(skills), state);
  });
}