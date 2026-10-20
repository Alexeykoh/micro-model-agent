/**
 * Проекция текста/структуры в «безопасный» вид для конкретной цели (E1/E2):
 * классифицирует, выбирает маску/токен по классу и режиму, собирает результат.
 * Единственная точка редакции — второй путь запрещён (INV-D3/D7).
 */
import { classify } from "./classify";
import type { PolicyContext } from "./context";
import type { DataClass, EgressTarget, EgressTokenRef, Finding } from "./types";
import type { DataPolicyConfig } from "./types";
import { isTaggedFileContent, untagFileContent } from "./file-content";
import { TokenMap } from "./tokens";

const MASK: Record<DataClass, string> = {
  path: "[PATH]",
  machine: "[HOST]",
  env: "[ENV]",
  secret: "[SECRET]",
  pii: "[PII]",
  "file-content": "[FILE]",
};

/** Классы, редактируемые для данной цели (secret — всегда; INV-D4/D2). */
export function enabledClasses(config: DataPolicyConfig, target: EgressTarget): Set<DataClass> {
  const set = new Set<DataClass>(["secret"]);
  // `trusted` покрывает оба вида цели: доверенный провайдер (loopback/allowlist)
  // и loopback-клиент webui (E2). `kind` сам по себе больше не форсирует редакцию.
  if (!target.trusted) {
    const e = config.egress;
    if (e.paths) set.add("path");
    if (e.machine) {
      set.add("machine");
      set.add("env");
    }
    if (e.pii) set.add("pii");
    if (e.fileContent) set.add("file-content");
  }
  return set;
}

/** Метаданные проекции одного текста. */
export interface TextProjection {
  text: string;
  changed: boolean;
  stats: Partial<Record<DataClass, number>>;
  findings: Finding[];
  /** Псевдонимы находок — для дедупликации в журнале хода. */
  tokens: EgressTokenRef[];
}

export interface ProjectPolicy {
  config: DataPolicyConfig;
  target: EgressTarget;
  ctx: PolicyContext;
  map: TokenMap;
}

/** Найти границу пути после `pos` (пробел/кавычка/запятая/конец) для режима `full`. */
function pathEnd(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && !/[\s"'`),;\]}]/.test(text[i])) i++;
  return i;
}

/** Спроецировать одну строку. */
export function projectText(text: string, policy: ProjectPolicy): TextProjection {
  const { config, target, ctx, map } = policy;
  if (!text || !config.enabled) {
    return { text, changed: false, stats: {}, findings: [], tokens: [] };
  }
  // §4.8: содержимое из-block пути режется по пути, а не по PII-паттернам.
  // Доверенный (локальный) egress получает оригинал без служебного тега.
  if (isTaggedFileContent(text)) {
    if (target.trusted || !config.egress.fileContent) {
      return { text: untagFileContent(text), changed: true, stats: {}, findings: [], tokens: [] };
    }
    return {
      text: MASK["file-content"],
      changed: true,
      stats: { "file-content": 1 },
      findings: [],
      tokens: [{ dataClass: "file-content", kind: "file-content", token: MASK["file-content"] }],
    };
  }
  const classes = enabledClasses(config, target);
  const findings = classify(text, ctx).filter(
    (f) => classes.has(f.dataClass) && f.confidence >= config.minConfidence,
  );
  if (findings.length === 0) return { text, changed: false, stats: {}, findings, tokens: [] };

  let out = "";
  let cursor = 0;
  const stats: Partial<Record<DataClass, number>> = {};
  const tokens: EgressTokenRef[] = [];
  for (const f of findings) {
    if (f.start < cursor) continue;
    let end = f.end;
    // pathMode:prefix — для путей, начинающихся с известного корня, сохраняем остаток.
    const pseudonym = config.pseudonymize && f.dataClass !== "secret";
    if (config.pathMode === "full" && f.dataClass === "path") {
      end = pathEnd(text, f.end);
    }
    out += text.slice(cursor, f.start);
    const token = pseudonym ? map.tokenFor(text.slice(f.start, end), f.dataClass) : MASK[f.dataClass];
    out += token;
    tokens.push({ dataClass: f.dataClass, kind: f.kind, token });
    cursor = end;
    stats[f.dataClass] = (stats[f.dataClass] ?? 0) + 1;
  }
  out += text.slice(cursor);
  return { text: out, changed: out !== text, stats, findings, tokens };
}

/** Результат глубокой проекции произвольной структуры. */
export interface Projected<T> {
  messages: T;
  changed: boolean;
  stats: Partial<Record<DataClass, number>>;
  tokens: EgressTokenRef[];
}

/** Рекурсивно спроецировать структуру (строки внутри объектов/массивов). */
export function projectDeep<T>(value: T, policy: ProjectPolicy): Projected<T> {
  const stats: Partial<Record<DataClass, number>> = {};
  const tokens: EgressTokenRef[] = [];
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = projectText(v, policy);
      if (r.changed) changed = true;
      for (const [k, n] of Object.entries(r.stats)) {
        stats[k as DataClass] = (stats[k as DataClass] ?? 0) + (n ?? 0);
      }
      tokens.push(...r.tokens);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(obj)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return { messages: walk(value) as T, changed, stats, tokens };
}
