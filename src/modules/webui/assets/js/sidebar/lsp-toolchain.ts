// Строка «тулчейн» во вкладке LSP: распознанные версии рантаймов и пакетов
// проекта (все языки). Вынесено из `lsp.ts` (правило ≤300).
import { t } from "../i18n.js";
import type { Dict } from "../core/store/types.js";
import { mapKv } from "./map.js";

/** Рантаймы (`node 16.13.0`) и пакеты (`typescript 4.1.6`) одной dim-строкой. */
export function appendToolchain(host: HTMLElement, tc: Dict | undefined): void {
  if (!tc || typeof tc !== "object") return;
  const runtimes = Array.isArray(tc.runtimes) ? tc.runtimes : [];
  const packages = tc.packages && typeof tc.packages === "object" ? tc.packages : {};
  const parts = [
    ...runtimes.map((r: Dict) => `${r.name} ${r.version}`),
    ...Object.entries(packages).map(([name, version]) => `${name} ${version}`),
  ].filter(Boolean);
  if (!parts.length) return;
  host.appendChild(mapKv(t("web.sidebar.lsp_toolchain"), parts.join(" · ")));
}
