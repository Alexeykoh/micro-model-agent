/**
 * Журнал DLP-редакции за ход (INV-DLP-1…5).
 *
 * Process-global, но агрегаты строго per-session: диагностика E1 приходит из
 * глобального sink'а, а бакет открывает webui-ход. Это закрывает долг
 * `egress-diagnostics-parallel` (раньше sink в параллельных сессиях указывал на
 * последнюю созданную).
 *
 * Наружу отдаётся только `EgressTurnSummary`: без оригиналов и token id.
 */
import type {
  DataClass,
  EgressTarget,
  EgressTurnSummary,
  GuardDiagnostic,
} from "./types";

interface Bucket {
  /** Уникальные токенизированные значения: token → класс/вид/отпечаток. */
  tokens: Map<string, { dataClass: DataClass; kind: string; preview?: string }>;
  /** Маски без id (`[SECRET]`, `[FILE]`): key `class\0kind` → max за вызов. */
  maskedMax: Map<string, number>;
  /** Маскированные отпечатки секретов: внутренний вид → уникальные значения. */
  secretPreviews: Map<string, Set<string>>;
  targets: Map<string, EgressTurnSummary["targets"][number]>;
}

/** Публичные виды секретов: внутренние id паттернов наружу не выходят. */
const SECRET_KIND_PUBLIC: Record<string, string> = {
  "secret:key": "key",
  "secret:bearer": "bearer",
  "secret:jwt": "jwt",
  "secret:prefix": "prefix",
};

/** Кап отпечатков на вид: агрегат не должен расти вместе с ходом (INV-DLP-8). */
const MAX_SECRET_PREVIEWS = 6;

function publicSecretKind(kind: string): string {
  const mapped = SECRET_KIND_PUBLIC[kind];
  if (mapped) return mapped;
  return kind.startsWith("secret:") ? "other" : kind;
}

const buckets = new Map<string, Bucket>();
/** Последнее известное назначение сессии — чтобы чистый ход тоже знал target. */
const knownTargets = new Map<string, EgressTurnSummary["targets"][number]>();

/** Токен с id (`<PATH:abc>`) дедуплицируется; маска (`[SECRET]`) — нет. */
function isTokenized(token: string): boolean {
  return /^<[A-Za-z-]+:[^>]+>$/.test(token);
}

function targetKey(t: { trusted: boolean; host?: string }): string {
  return `${t.trusted ? "trusted" : "external"}\0${t.host ?? ""}`;
}

function addTarget(bucket: Bucket, target: EgressTarget): void {
  if (target.kind !== "provider") return;
  const value = { kind: "provider" as const, trusted: target.trusted, host: target.host };
  bucket.targets.set(targetKey(value), value);
}

function freshBucket(sessionId: string): Bucket {
  const bucket: Bucket = {
    tokens: new Map(),
    maskedMax: new Map(),
    secretPreviews: new Map(),
    targets: new Map(),
  };
  const known = knownTargets.get(sessionId);
  if (known) bucket.targets.set(targetKey(known), known);
  return bucket;
}

/** Открыть ход: старый незакрытый бакет сессии отбрасывается. */
export function beginEgressTurn(sessionId: string): void {
  if (!sessionId) return;
  buckets.set(sessionId, freshBucket(sessionId));
}

/** Запомнить назначение сессии (вызывается фабрикой guard'а при сборке). */
export function noteEgressTarget(sessionId: string | undefined, target: EgressTarget): void {
  if (!sessionId || target.kind !== "provider") return;
  const value = { kind: "provider" as const, trusted: target.trusted, host: target.host };
  knownTargets.set(sessionId, value);
  const bucket = buckets.get(sessionId);
  if (bucket) bucket.targets.set(targetKey(value), value);
}

/** Учесть диагностику; всё, кроме `redacted`/провайдера/активной сессии, — мимо. */
export function recordEgressTurn(diag: GuardDiagnostic): void {
  if (diag.outcome !== "redacted") return;
  if (diag.target?.kind !== "provider") return;
  const sessionId = diag.sessionId;
  if (!sessionId) return;
  const bucket = buckets.get(sessionId);
  if (!bucket) return;

  addTarget(bucket, diag.target);
  const perCall = new Map<string, number>();
  for (const ref of diag.tokens ?? []) {
    if (isTokenized(ref.token)) {
      if (!bucket.tokens.has(ref.token)) {
        bucket.tokens.set(ref.token, {
          dataClass: ref.dataClass,
          kind: ref.kind,
          ...(ref.preview ? { preview: ref.preview } : {}),
        });
      }
      continue;
    }
    const key = `${ref.dataClass}\0${ref.kind}`;
    perCall.set(key, (perCall.get(key) ?? 0) + 1);
    if (ref.dataClass === "secret" && ref.preview) {
      const previews = bucket.secretPreviews.get(ref.kind) ?? new Set<string>();
      if (previews.size < MAX_SECRET_PREVIEWS) previews.add(ref.preview);
      bucket.secretPreviews.set(ref.kind, previews);
    }
  }
  // max, не сумма: title-gen повторяет те же значения в том же ходу.
  for (const [key, n] of perCall) {
    bucket.maskedMax.set(key, Math.max(bucket.maskedMax.get(key) ?? 0, n));
  }
}

function summaryOf(bucket: Bucket): EgressTurnSummary {
  const stats: Partial<Record<DataClass, number>> = {};
  const kinds: Partial<Record<DataClass, Set<string>>> = {};
  const secretDetails = new Map<string, { count: number; previews: Set<string> }>();

  // Наружу не отдаём внутренние id паттернов (`secret:0`): E2-редактор webui
  // принимает их за секрет и переписывает в `[SECRET]` прямо в истории/SSE.
  const publicKind = (dataClass: DataClass, kind: string): string =>
    dataClass === "secret" ? "secret" : kind;
  const addKind = (dataClass: DataClass, kind: string): void => {
    const set = kinds[dataClass] ?? new Set<string>();
    set.add(publicKind(dataClass, kind));
    kinds[dataClass] = set;
  };
  const addSecret = (kind: string, count: number, previews: Iterable<string>): void => {
    const pub = publicSecretKind(kind);
    const acc = secretDetails.get(pub) ?? { count: 0, previews: new Set<string>() };
    acc.count += count;
    for (const preview of previews) {
      if (acc.previews.size >= MAX_SECRET_PREVIEWS) break;
      acc.previews.add(preview);
    }
    secretDetails.set(pub, acc);
  };

  for (const ref of bucket.tokens.values()) {
    stats[ref.dataClass] = (stats[ref.dataClass] ?? 0) + 1;
    addKind(ref.dataClass, ref.kind);
    if (ref.dataClass === "secret") {
      addSecret(ref.kind, 1, ref.preview ? [ref.preview] : []);
    }
  }
  for (const [key, n] of bucket.maskedMax) {
    const [dataClass, kind] = key.split("\0") as [DataClass, string];
    stats[dataClass] = (stats[dataClass] ?? 0) + n;
    addKind(dataClass, kind);
    if (dataClass === "secret") {
      addSecret(kind, n, bucket.secretPreviews.get(kind) ?? []);
    }
  }

  const kindsOut: Partial<Record<DataClass, string[]>> = {};
  for (const [dataClass, set] of Object.entries(kinds) as Array<[DataClass, Set<string>]>) {
    kindsOut[dataClass] = [...set].sort();
  }

  const secrets = [...secretDetails]
    .map(([kind, acc]) => ({ kind, count: acc.count, previews: [...acc.previews].sort() }))
    .sort((a, b) => a.kind.localeCompare(b.kind));

  return {
    total: Object.values(stats).reduce((a, b) => a + b, 0),
    stats,
    kinds: kindsOut,
    ...(secrets.length ? { secrets } : {}),
    targets: [...bucket.targets.values()],
  };
}

/** Закрыть ход и забрать агрегат; `undefined` — ход не открывался. */
export function endEgressTurn(sessionId: string): EgressTurnSummary | undefined {
  const bucket = buckets.get(sessionId);
  if (!bucket) return undefined;
  buckets.delete(sessionId);
  return summaryOf(bucket);
}

/** Только для тестов: сбросить журнал и известные цели. */
export function resetEgressTurnJournal(): void {
  buckets.clear();
  knownTargets.clear();
}
