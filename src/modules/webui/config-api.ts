/**
 * REST handlers for the config / model surfaces of `mma web`.
 *
 * Split out of `server.ts` (rule #1: ≤300 lines/file). Every handler takes the
 * shared {@link WebUiState} and reads the optional collaborators the module
 * wires from bootstrap (`config`, `saveConfig`, `reconfigure`, `knownModels`). A
 * missing collaborator is a server-side wiring gap, not a client error: those
 * endpoints answer 503 instead of crashing. Session routes live in
 * `sessions-api.ts`.
 *
 * Auth + same-origin are enforced upstream in `server.ts`; these functions
 * assume the request already passed both checks.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { setLocale } from "../../i18n";
import { redactConfigSecrets } from "../../config/redact";
import { configDefs, setConfigValue } from "../../config/registry";
import { readBodyError, sendJson } from "./util";
import { readJsonBody } from "./body";
import { persistAndReconfigure } from "./persist";
import type { WebUiState } from "./state";

/** Registry entry shape consumed by the settings UI. */
export interface ConfigRegistryEntry {
  key: string;
  aliases: string[];
  valueType: string;
  group: string;
  enum?: readonly string[];
  /**
   * Numeric bounds for `int`/`share` controls. Sourced from the registry defs
   * where real metadata exists (e.g. shares use the same 0.05–0.9 limits the
   * parser enforces, `contextWindow` min 1024); omitted for unbounded keys.
   */
  min?: number;
  max?: number;
  step?: number;
  /** `version` and similar keys render as a non-editable value in the UI. */
  readOnly?: boolean;
}

/** Serialize the registry in registry order (canonical keys only). */
export function buildConfigRegistry(): ConfigRegistryEntry[] {
  return configDefs().map((def) => {
    const entry: ConfigRegistryEntry = {
      key: def.key,
      aliases: def.aliases,
      valueType: def.valueType,
      group: def.domain,
    };
    if (def.enumValues) entry.enum = def.enumValues;
    if (def.min !== undefined) entry.min = def.min;
    if (def.max !== undefined) entry.max = def.max;
    if (def.step !== undefined) entry.step = def.step;
    if (def.readOnly) entry.readOnly = true;
    return entry;
  });
}

/** Mask a secret for display: keep the last 4 chars, hide the rest. */
function maskToken(token: string | null): string | null {
  if (!token) return null;
  return token.length <= 4 ? "••••" : `••••${token.slice(-4)}`;
}

/** `GET /api/config` — redacted live config + key registry. */
export function handleConfigGet(res: ServerResponse, s: WebUiState): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  sendJson(res, 200, {
    config: redactConfigSecrets(s.config),
    registry: buildConfigRegistry(),
    webToken: maskToken(s.token),
  });
}

/** Coerce a JSON `value` into the raw string `setConfigValue` expects. */
function toRawValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** `POST /api/config {key, value}` — validate, apply, persist, reconfigure. */
export function handleConfigPost(
  req: IncomingMessage,
  res: ServerResponse,
  s: WebUiState,
): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  const config = s.config;
  readJsonBody(req, s.maxBodyBytes)
    .then(async (rec) => {
      if (!rec) {
        sendJson(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }
      const key = typeof rec.key === "string" ? rec.key : "";
      const rawValue = toRawValue(rec.value);
      if (!key || rawValue === null) {
        sendJson(res, 400, { ok: false, error: "invalid-value" });
        return;
      }

      const result = setConfigValue(config, key, rawValue);
      if (!result.ok) {
        sendJson(res, 400, { ok: false, error: result.reason });
        return;
      }

      // `locale` has `reconfigure: false` (registry), so nothing else applies it
      // to the process-wide i18n state. Do it here so server-side output and the
      // browser's re-fetched dictionary agree immediately.
      if (key === "locale") setLocale(config.locale);

      // Persist first, then reconfigure — but only when the registry says the
      // key needs a reconfigure; otherwise the shared step would needlessly
      // refresh providers/models on every keystroke.
      let persisted = true;
      let warning: string | undefined;
      if (result.reconfigure) {
        ({ persisted, warning } = await persistAndReconfigure(s, config));
      } else {
        try {
          s.saveConfig?.(config);
        } catch {
          persisted = false;
          warning = "config not persisted";
        }
      }
      const body: Record<string, unknown> = {
        ok: true,
        value: result.value,
        display: result.display,
        persisted,
      };
      if (warning) body.warning = warning;
      sendJson(res, 200, body);
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}

/** `GET /api/models` — model ids known to the active provider. */
export function handleModelsGet(res: ServerResponse, s: WebUiState): void {
  if (!s.knownModels) {
    sendJson(res, 503, { error: "models_unavailable" });
    return;
  }
  sendJson(res, 200, { models: s.knownModels() });
}
