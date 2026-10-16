/**
 * Реестр обработчиков документов: разрешение по расширению/содержимому, разбор
 * в `DocumentIR` и состояние для `health()`. Единственное место, импортирующее
 * `handlers/*` (INV-D2) и собирающее активный набор из переключателей (INV-D3).
 */
import { extname } from "node:path";
import type { Logger } from "../../logger/app-logger";
import { DEFAULT_DOC_LIMITS } from "./bound";
import {
  detectHead,
  type DocSource,
  type DocumentHandler,
  type HandlerGroup,
  type ParseContext,
} from "./handler";
import type { DocumentIR } from "./ir";
import { ACTIVE_GROUPS, DOCUMENTS_ENABLED, HANDLERS } from "./handlers/index";

export interface RegistryOptions {
  enabled?: boolean;
  groups?: readonly HandlerGroup[];
  handlers?: readonly DocumentHandler[];
}

/** Состояние реестра для `health()` (INV-D5: деградация видна). */
export interface RegistryHealth {
  status: "ok" | "degraded";
  reason?: string;
  groups: HandlerGroup[];
  handlers: string[];
}

export interface DocumentRegistry {
  resolve(path: string, head: Uint8Array): DocumentHandler | null;
  parse(ctx: ParseContext, source: DocSource): Promise<DocumentIR>;
  active(): RegistryHealth;
}

/** Собирает реестр из включённых групп/обработчиков (INV-D3). */
export function buildRegistry(opts: RegistryOptions = {}): DocumentRegistry {
  const enabled = opts.enabled ?? DOCUMENTS_ENABLED;
  const groups = opts.groups ?? ACTIVE_GROUPS;
  const all = opts.handlers ?? HANDLERS;
  const active = enabled ? all.filter((h) => groups.includes(h.group)) : [];

  const byExt = new Map<string, DocumentHandler>();
  for (const h of active) for (const e of h.extensions) byExt.set(e.toLowerCase(), h);

  return {
    resolve(path, head) {
      const h = byExt.get(extname(path).toLowerCase());
      if (h?.detect && !h.detect(head)) return null;
      return h ?? null;
    },
    async parse(ctx, source) {
      const head = (await source.bytes()).slice(0, 8);
      const h = this.resolve(source.path, head);
      if (!h) throw new Error(`no handler for ${source.path}`);
      return h.parse(ctx, source);
    },
    active() {
      return { status: "ok", groups: [...groups], handlers: active.map((h) => h.id) };
    },
  };
}

/** Контекст разбора из логера и дефолтных лимитов. */
export function parseCtx(logger: Logger): ParseContext {
  return { logger, limits: DEFAULT_DOC_LIMITS };
}

export { detectHead };
