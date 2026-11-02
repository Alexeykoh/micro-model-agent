/**
 * Проекция текста/структуры в «безопасный» вид для конкретной цели (E1/E2):
 * классифицирует, выбирает маску/токен по классу и режиму, собирает результат.
 * Единственная точка редакции — второй путь запрещён (INV-D3/D7).
 */
import { classify } from "./classify";
import type { PolicyContext } from "./context";
import type { DataClass, EgressHit, EgressSurface, EgressTarget, EgressTokenRef, Finding } from "./types";
import type { DataPolicyConfig } from "./types";
import { isTaggedFileContent, untagFileContent } from "./file-content";
import { secretPreview } from "./detectors/secrets";
import { matchAnyGlob, relativeTo } from "./path-policy";
import { decodePercentText } from "./detectors/joined";
import { resolve } from "node:path";
import { TokenMap } from "./tokens";

const MASK: Record<DataClass, string> = {
  path: "[PATH]",
  machine: "[HOST]",
  env: "[ENV]",
  secret: "[SECRET]",
  pii: "[PII]",
  "file-content": "[FILE]",
};

/** Классы, редактируемые для данной цели (secret — по флагу; INV-D4/D2). */
export function enabledClasses(config: DataPolicyConfig, target: EgressTarget): Set<DataClass> {
  const set = new Set<DataClass>();
  // Секреты — по отдельному флагу: политика «не отдаём секреты даже доверенному»
  // (§6 спеки 2026-10-19) держится дефолтом `true`, но оператор с полностью
  // локальным стеком может её выключить (INV-S5 спеки 2026-10-20).
  // `undefined` (конфиг без нового ключа) = прежнее поведение — секреты прячем.
  if (config.egress.secrets !== false) set.add("secret");
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
  /** Позиции и метки замен — основа позиционной детализации (U21). */
  redactions: TextRedaction[];
}

/** Одна замена в тексте: диапазон + метка, без оригинала. */
export interface TextRedaction {
  dataClass: DataClass;
  kind: string;
  start: number;
  end: number;
  replacement: string;
  preview?: string;
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

/**
 * Путь скрыт от этой цели по glob-списку? `apiHiddenGlobs` — для API-клиента,
 * `providerBlockGlobs` — для внешнего провайдера (D2). Скрытый путь маскируется
 * **целиком**, а не только корнем: иначе в `tool_start.args`/`tool_end.output`
 * остаётся хвост `<PATH>\secret\a.txt` (долг `api-hidden-globs-text-scope`).
 * Сравнение — по нормализованному относительному пути, без FS-чтения.
 */
function pathHiddenByPolicy(
  pathText: string,
  config: DataPolicyConfig,
  target: EgressTarget,
  ctx: PolicyContext,
): boolean {
  const globs =
    target.kind === "api"
      ? config.apiHiddenGlobs
      : target.trusted
        ? []
        : config.providerBlockGlobs;
  if (!globs.length) return false;
  // Границы сравниваем по нормализованному пути: percent-encoding и удвоенные
  // обратные слэши (JSON) не должны прятать скрытый файл от glob-матчинга.
  const decoded = decodePercentText(pathText).replace(/\\\\/g, "\\");
  const rel = relativeTo(ctx.baseDir, resolve(ctx.baseDir, decoded));
  return matchAnyGlob(rel, globs) !== undefined;
}

/** Спроецировать одну строку. */
export function projectText(text: string, policy: ProjectPolicy): TextProjection {
  const { config, target, ctx, map } = policy;
  if (!text || !config.enabled) {
    return { text, changed: false, stats: {}, findings: [], tokens: [], redactions: [] };
  }
  // §4.8: содержимое из-block пути режется по пути, а не по PII-паттернам.
  // Доверенный (локальный) egress получает оригинал без служебного тега.
  if (isTaggedFileContent(text)) {
    if (target.trusted || !config.egress.fileContent) {
      return {
        text: untagFileContent(text),
        changed: true,
        stats: {},
        findings: [],
        tokens: [],
        redactions: [],
      };
    }
    return {
      text: MASK["file-content"],
      changed: true,
      stats: { "file-content": 1 },
      findings: [],
      tokens: [{ dataClass: "file-content", kind: "file-content", token: MASK["file-content"] }],
      redactions: [
        {
          dataClass: "file-content",
          kind: "file-content",
          start: 0,
          end: text.length,
          replacement: MASK["file-content"],
        },
      ],
    };
  }
  const classes = enabledClasses(config, target);
  const findings = classify(text, ctx).filter(
    (f) => classes.has(f.dataClass) && f.confidence >= config.minConfidence,
  );
  if (findings.length === 0) {
    return { text, changed: false, stats: {}, findings, tokens: [], redactions: [] };
  }

  let out = "";
  let cursor = 0;
  const stats: Partial<Record<DataClass, number>> = {};
  const tokens: EgressTokenRef[] = [];
  const redactions: TextRedaction[] = [];
  for (const f of findings) {
    if (f.start < cursor) continue;
    let end = f.end;
    // pathMode:prefix — для путей, начинающихся с известного корня, сохраняем остаток.
    const pseudonym = config.pseudonymize && f.dataClass !== "secret";
    const pathFinding = f.dataClass === "path";
    let hiddenPath = false;
    if (pathFinding) {
      // Классификатор отдаёт префикс корня; скрытость и «полный» режим
      // решаются по целому пути (остаток за префиксом входит в находку).
      const fullEnd = pathEnd(text, f.end);
      hiddenPath = pathHiddenByPolicy(
        text.slice(f.start, fullEnd),
        config,
        target,
        ctx,
      );
      if (hiddenPath || config.pathMode === "full") end = fullEnd;
    }
    out += text.slice(cursor, f.start);
    const token =
      pseudonym && !hiddenPath
        ? map.tokenFor(text.slice(f.start, end), f.dataClass)
        : MASK[f.dataClass];
    out += token;
    const preview = f.dataClass === "secret" ? secretPreview(text.slice(f.start, end)) : undefined;
    tokens.push({ dataClass: f.dataClass, kind: f.kind, token, ...(preview ? { preview } : {}) });
    redactions.push({
      dataClass: f.dataClass,
      kind: f.kind,
      start: f.start,
      end,
      // token id (`<PATH:abc>`) наружу не уходит (INV-DLP-1): показываем метку.
      replacement: pseudonym && !hiddenPath ? `‹${f.dataClass.toUpperCase()}›` : MASK[f.dataClass],
      ...(preview ? { preview } : {}),
    });
    cursor = end;
    stats[f.dataClass] = (stats[f.dataClass] ?? 0) + 1;
  }
  out += text.slice(cursor);
  return { text: out, changed: out !== text, stats, findings, tokens, redactions };
}

/** Результат глубокой проекции произвольной структуры. */
export interface Projected<T> {
  messages: T;
  changed: boolean;
  stats: Partial<Record<DataClass, number>>;
  tokens: EgressTokenRef[];
}

/** Где лежит спроецированная строка (U21). */
export interface HitLocator {
  surface: EgressSurface;
  messageIdx?: number;
  role?: string;
  tool?: string;
}

/** Параметры глубокой проекции: приёмник позиций и локатор строки. */
export interface ProjectDeepOptions {
  sink?: (hit: EgressHit) => void;
  locator?: (path: ReadonlyArray<string | number>) => HitLocator;
}

/** Путь строки в структуре → короткое поле (`content.0.text`). */
function fieldOf(path: ReadonlyArray<string | number>): string | undefined {
  if (path.length === 0) return undefined;
  // `projectDeep` часто получает сам массив сообщений: [idx, "content", …].
  const skip =
    (path[0] === "messages" && typeof path[1] === "number") || typeof path[0] === "number"
      ? path[0] === "messages"
        ? 2
        : 1
      : 0;
  const rest = path.slice(skip).join(".");
  return rest || undefined;
}

/** Рекурсивно спроецировать структуру (строки внутри объектов/массивов). */
export function projectDeep<T>(value: T, policy: ProjectPolicy, opts?: ProjectDeepOptions): Projected<T> {
  const stats: Partial<Record<DataClass, number>> = {};
  const tokens: EgressTokenRef[] = [];
  let changed = false;
  const walk = (v: unknown, path: Array<string | number>): unknown => {
    if (typeof v === "string") {
      const r = projectText(v, policy);
      if (r.changed) changed = true;
      for (const [k, n] of Object.entries(r.stats)) {
        stats[k as DataClass] = (stats[k as DataClass] ?? 0) + (n ?? 0);
      }
      tokens.push(...r.tokens);
      if (opts?.sink && r.redactions.length) {
        const loc = opts.locator?.(path) ?? { surface: "message" as EgressSurface };
        const field = fieldOf(path);
        for (const red of r.redactions) {
          opts.sink({
            ...loc,
            dataClass: red.dataClass,
            kind: red.kind,
            start: red.start,
            end: red.end,
            replacement: red.replacement,
            ...(red.preview ? { preview: red.preview } : {}),
            ...(field ? { field } : {}),
          });
        }
      }
      return r.text;
    }
    if (Array.isArray(v)) return v.map((item, i) => walk(item, [...path, i]));
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(obj)) out[k] = walk(val, [...path, k]);
      return out;
    }
    return v;
  };
  return { messages: walk(value, []) as T, changed, stats, tokens };
}
