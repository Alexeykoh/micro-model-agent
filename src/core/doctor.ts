// Единая диагностика установки: `mma doctor` и `/doctor`.
//
// Сводит в одну сводку то, что раньше разбросано по точечным механизмам:
// окружение (`EnvironmentReport`), состояние модулей (`ModuleHost.health`,
// INV-5/6), плагины, активный провайдер, LSP и конфиг. Сборка — здесь, формат
// вывода — на поверхности (терминал/REPL красят сами).
import { existsSync } from "fs";
import { join } from "path";
import type { AppConfig } from "../config/types";
import type { EnvironmentReport } from "./environment";
import type { ModuleHost } from "./module-host";
import type { PluginManager } from "../modules/plugins/manager";

/** Итог секции: `fail` делает весь отчёт «не ок». */
export type DoctorStatus = "ok" | "warn" | "fail";

/** Одна секция отчёта: заголовок, статус и строки-детали. */
export interface DoctorSection {
  title: string;
  status: DoctorStatus;
  lines: string[];
}

/** Полный отчёт `doctor`; `ok` — ни одной `fail`-секции. */
export interface DoctorReport {
  ok: boolean;
  sections: DoctorSection[];
}

/** Вход сборки: только уже собранные bootstrap-коллабораторы. */
export interface DoctorInput {
  config: AppConfig;
  configDir: string;
  baseDir: string;
  envReport?: EnvironmentReport;
  moduleHost?: ModuleHost;
  pluginManager?: PluginManager;
  /** LSP-модуль (может быть не подключён — тогда секция помечает это). */
  lsp?: { getFlags?(): { enabled: boolean; offline: boolean } } | null;
}

const RANK: Record<DoctorStatus, number> = { ok: 0, warn: 1, fail: 2 };

/** Берёт худший из двух статусов. */
function worst(a: DoctorStatus, b: DoctorStatus): DoctorStatus {
  return RANK[b] > RANK[a] ? b : a;
}

/** Собирает отчёт `doctor` из готовых коллабораторов. */
export function buildDoctorReport(input: DoctorInput): DoctorReport {
  const sections: DoctorSection[] = [
    environmentSection(input),
    providerSection(input.config),
    modulesSection(input.moduleHost),
    pluginsSection(input.pluginManager),
    lspSection(input.config, input.lsp),
    configSection(input),
  ];
  return { ok: sections.every((s) => s.status !== "fail"), sections };
}

/** Плоский список строк отчёта (без цвета) для печати на любой поверхности. */
export function formatDoctorReport(report: DoctorReport): string[] {
  const out: string[] = [];
  for (const s of report.sections) {
    out.push(`${s.title} [${s.status}]`);
    for (const line of s.lines) out.push(`  ${line}`);
  }
  out.push(report.ok ? "doctor: OK" : "doctor: problems found");
  return out;
}

function environmentSection(input: DoctorInput): DoctorSection {
  const { envReport: r } = input;
  if (!r) {
    return {
      title: "Environment",
      status: "warn",
      lines: [
        `runtime: ${process.release?.name ?? "node"} ${process.version}`,
        `config: ${input.configDir}`,
        `workdir: ${input.baseDir}`,
        "environment report unavailable",
      ],
    };
  }
  const lines = [
    `mma ${r.mmaVersion}`,
    `runtime: ${r.runtime.runtime} ${r.runtime.runtimeVersion} (node ${r.runtime.nodeVersion})` +
      (r.runtime.engineOk ? "" : ` — below engines ${r.runtime.engine}`),
    `os: ${r.os.platform} ${r.os.arch} · shell ${r.os.shell}`,
    `cwd: ${r.os.cwd}`,
    `config: ${r.paths.configDir}`,
  ];
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  return { title: "Environment", status: r.warnings.length > 0 ? "warn" : "ok", lines };
}

function providerSection(config: AppConfig): DoctorSection {
  const p = config.provider;
  const active = p?.active || p?.type || "unknown";
  const entry = p?.entries?.find((e) => e.label === p.active || e.type === p.active);
  const baseUrl = entry?.baseUrl || p?.baseUrl || "";
  const lines = [
    `active: ${active}`,
    `model: ${config.model}`,
    `baseUrl: ${baseUrl || "(none)"}`,
    `context: ${config.contextWindow} tok`,
  ];
  return { title: "Provider", status: baseUrl ? "ok" : "warn", lines };
}

function modulesSection(host?: ModuleHost): DoctorSection {
  if (!host) {
    return { title: "Modules", status: "warn", lines: ["module host unavailable"] };
  }
  const health = host.health();
  let status: DoctorStatus = "ok";
  const lines = health.map(({ name, health: h }) => {
    status = worst(status, h.status === "failed" ? "fail" : h.status === "degraded" ? "warn" : "ok");
    return `${name}: ${h.status}${h.reason ? ` — ${h.reason}` : ""}`;
  });
  if (lines.length === 0) lines.push("(no modules registered)");
  return { title: "Modules", status, lines };
}

function pluginsSection(pm?: PluginManager): DoctorSection {
  if (!pm) {
    return { title: "Plugins", status: "warn", lines: ["plugin manager unavailable"] };
  }
  const records = pm.getRecords();
  const disabled = records.filter((r) => !r.enabled).length;
  const failures = pm.getFailures();
  const lines = [`loaded: ${records.length - disabled} active / ${records.length} total`];
  if (disabled > 0) lines.push(`disabled: ${disabled}`);
  for (const f of failures) lines.push(`failed: ${f.entry} — ${f.message}`);
  return { title: "Plugins", status: failures.length > 0 ? "warn" : "ok", lines };
}

function lspSection(
  config: AppConfig,
  lsp?: { getFlags?(): { enabled: boolean; offline: boolean } } | null,
): DoctorSection {
  const enabled = config.lsp?.enabled ?? false;
  const flags = lsp?.getFlags?.();
  const servers = Object.keys(config.lsp?.servers ?? {}).length;
  const lines = [
    `enabled: ${enabled}${lsp ? "" : " (module not attached)"}`,
    `offline: ${flags?.offline ?? config.lsp?.offline ?? false}`,
    `servers: ${servers}`,
  ];
  const status: DoctorStatus = enabled && !lsp ? "warn" : "ok";
  return { title: "LSP", status, lines };
}

function configSection(input: DoctorInput): DoctorSection {
  const domainDir = join(input.configDir, "config");
  const legacy = join(input.configDir, "config.json");
  const stored = existsSync(domainDir) ? "domain files" : existsSync(legacy) ? "legacy config.json" : "defaults (not saved)";
  const lines = [
    `dir: ${input.configDir}`,
    `stored: ${stored}`,
    `workdir: ${input.baseDir}`,
    `locale: ${input.config.locale}`,
    `tool tags: ${(input.config.tools?.defaultTags ?? []).length}`,
  ];
  return { title: "Config", status: "ok", lines };
}
