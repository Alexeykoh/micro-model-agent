// Дефы-таблицы и последние группы: pricing.overrides, capabilities моделей,
// эксперты, LSP и изображения. Вынесены из `registry-extra.ts` (правило 6);
// порядок внутри группы — порядок `EXTRA_DEFS`.
import type { AppConfig } from "./types";
import type { ConfigKeyDef } from "./registry";
import { DEFAULTS } from "./defaults";
import { DEFAULT_LSP_CONFIG } from "../modules/lsp/config";
import { bool, enumOf, int, isNonNegNum, isRecord, jsonShape } from "./registry-extra-factories";

export const CAPABILITY_DEFS: ConfigKeyDef[] = [
  jsonShape("pricing.overrides", "pricing",
    (c) => c.pricing?.overrides ?? {},
    (c, v) => {
      c.pricing ??= structuredClone(DEFAULTS.pricing!);
      c.pricing.overrides = v as Record<string, { input: number; output: number }>;
    },
    (v) => isRecord(v) && Object.values(v).every((e) =>
      isRecord(e) &&
      isNonNegNum(e.input) &&
      isNonNegNum(e.output) &&
      (e.cachedInput === undefined || isNonNegNum(e.cachedInput)) &&
      (e.cacheWrite === undefined || isNonNegNum(e.cacheWrite))),
    {
      kind: "table",
      columns: [
        { key: "name" },
        { key: "input", type: "number" },
        { key: "output", type: "number" },
        { key: "cachedInput", type: "number", optional: true },
        { key: "cacheWrite", type: "number", optional: true },
      ],
    }),

  jsonShape("modelCapabilities", "provider",
    (c) => c.modelCapabilities ?? {},
    (c, v) => { c.modelCapabilities = v as AppConfig["modelCapabilities"]; },
    (v) => isRecord(v) && Object.values(v).every((e) =>
      isRecord(e) &&
      (e.vision === undefined || typeof e.vision === "boolean") &&
      (e.tools === undefined || typeof e.tools === "boolean")),
    {
      kind: "table",
      columns: [
        { key: "name" },
        { key: "vision", type: "bool", optional: true },
        { key: "tools", type: "bool", optional: true },
      ],
    }),

  jsonShape("experts", "agent",
    (c) => c.experts,
    (c, v) => { c.experts = v as AppConfig["experts"]; },
    (v) => isRecord(v) && Object.values(v).every((e) =>
      isRecord(e) &&
      (e.model === undefined || typeof e.model === "string") &&
      (e.provider === undefined || typeof e.provider === "string") &&
      Array.isArray(e.tool_tags) &&
      e.tool_tags.every((t) => typeof t === "string") &&
      (e.max_attempts === undefined || (typeof e.max_attempts === "number" && Number.isFinite(e.max_attempts))) &&
      (e.description === undefined || typeof e.description === "string")),
    {
      kind: "table",
      columns: [
        { key: "name" },
        { key: "provider", optional: true, optionsSource: "providers", resets: ["model"], emptyLabelKey: "web.settings.active_provider" },
        { key: "model", optional: true, optionsSource: "models", dependsOn: "provider", emptyLabelKey: "web.settings.inherit_model" },
        { key: "tool_tags", array: true },
        { key: "max_attempts", type: "number", optional: true },
        { key: "description", optional: true },
      ],
    }),

  bool("lsp.enabled", "lsp", false,
    (c) => c.lsp?.enabled ?? true,
    (c, v) => {
      c.lsp ??= structuredClone(DEFAULT_LSP_CONFIG);
      c.lsp.enabled = v as boolean;
    }),
  bool("lsp.offline", "lsp", false,
    (c) => c.lsp?.offline ?? false,
    (c, v) => {
      c.lsp ??= structuredClone(DEFAULT_LSP_CONFIG);
      c.lsp.offline = v as boolean;
    }),
  enumOf("lsp.typescriptEngine", "lsp", ["typescript-language-server", "tsgo"], true,
    (c) => c.lsp?.typescriptEngine ?? DEFAULT_LSP_CONFIG.typescriptEngine,
    (c, v) => {
      c.lsp ??= structuredClone(DEFAULT_LSP_CONFIG);
      c.lsp.typescriptEngine = v as "typescript-language-server" | "tsgo";
    }),

  int("images.maxCount", "images", 1, 1000, 1, false,
    (c) => c.images?.maxCount ?? DEFAULTS.images!.maxCount,
    (c, v) => {
      c.images = { ...(c.images ?? DEFAULTS.images!), maxCount: v as number };
    }),
  int("images.maxBytes", "images", 1_048_576, 10_737_418_240, 1_048_576, false,
    (c) => c.images?.maxBytes ?? DEFAULTS.images!.maxBytes,
    (c, v) => {
      c.images = { ...(c.images ?? DEFAULTS.images!), maxBytes: v as number };
    }),
];
