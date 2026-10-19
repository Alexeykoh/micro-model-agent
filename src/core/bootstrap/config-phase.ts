/**
 * Фаза 1 bootstrap: пути, конфиг, локаль, логгер.
 *
 * Порядок сайд-эффектов 1:1 с исходным `bootstrap()`: резолв каталога →
 * `loadConfig` → `setLocale` → CLI-override reasoning → audit-нотифаер →
 * создание `Logger` (+ отложенное логирование ошибки нотифаера) → синк
 * бандл-манифеста сертификаций (best-effort, молча).
 */
import { join } from "path";
import { loadConfig } from "../../config/config";
import { DEFAULTS } from "../../config/defaults";
import { Logger } from "../../logger/app-logger";
import { setLocale, setMissingKeyReporter } from "../../i18n/index";
import { globalMmaDir } from "../../config/paths";
import type { AppConfig, ReasoningLevel } from "../../config/types";
import { errMsg } from "../../utils";
import { normalizeLogLevel } from "./state";

/**
 * CLI --reasoning переопределяет конфигурационный режим
 * (приоритет: CLI > config > default). "auto" пропускается — полагаемся
 * на конфиг. Строка CLI приводится к типизированному ReasoningLevel.
 */
export function applyReasoningCliOverride(
  config: AppConfig,
  reasoningLevel: string | undefined,
): void {
  if (!reasoningLevel || reasoningLevel === "auto") return;
  if (!config.reasoning) {
    // Секция строится из DEFAULTS, а не из литералов: ручная копия молча
    // расходилась с дефолтом (`overrideCooldown: 3` против 5) и теряла
    // `baseline`/будущие поля (W8, единый источник правды).
    config.reasoning = { ...DEFAULTS.reasoning!, mode: reasoningLevel as ReasoningLevel };
  } else {
    config.reasoning.mode = reasoningLevel as ReasoningLevel;
  }
}

/** Итог фазы конфига: каталог, конфиг, флаг легаси, готовый логгер. */
export interface ConfigPhase {
  /** Каталог конфига (резолвнутый). */
  dir: string;
  /** Путь проектного `.mmrc` (для `loadConfig`). */
  projectConfigPath: string;
  /** Загруженный конфиг (мутабельный, живой на всю сессию). */
  config: AppConfig;
  /** true при легаси config.json (доменных файлов нет). */
  legacyDetected: boolean;
  /** Настроенный логгер (logDir + i18n-репортер уже подключены). */
  logger: Logger;
}

/**
 * Грузит конфиг и готовит логгер.
 * @param configDir каталог конфига (опционально); @param projectDir workspace (опционально);
 * @param reasoningLevel CLI-override reasoning (опционально).
 * @returns каталог, конфиг, флаг легаси и логгер.
 */
export async function initConfigPhase(
  configDir?: string,
  projectDir?: string,
  reasoningLevel?: string,
): Promise<ConfigPhase> {
  const dir = configDir || globalMmaDir();
  const projectConfigPath = projectDir ? join(projectDir, ".mmrc") : join(process.cwd(), ".mmrc");

  const { config, legacyDetected } = loadConfig({ configDir: dir, projectConfigPath });
  setLocale(config.locale);

  // CLI --reasoning перебивает режим конфига (приоритет: CLI > config > default)
  applyReasoningCliOverride(config, reasoningLevel);

  // Глобальный audit-нотифаер — по конфигу
  let auditNotifyError: string | undefined;
  try {
    const { globalAuditNotifier, setAuditEgressGuard } = await import(
      "../../modules/security/audit-notifier"
    );
    if (config.security?.auditNotifier) {
      globalAuditNotifier.updateConfig({
        ...(config.security.auditNotifier as Partial<typeof config.security.auditNotifier>),
        // Политика исходящих вызовов каркаса (W13): адресат webhook-нотификации
        // проверяется по сетевой политике, а не «как получилось».
        ...(config.security.network ? { networkConfig: config.security.network } : {}),
      });
    }
    // E2: webhook-нотификации — внешний egress, payload проходит ту же DLP.
    const { apiGuard } = await import("../../modules/webui/egress");
    setAuditEgressGuard(apiGuard({ config, workspace: projectDir }));
  } catch (err) {
    // Logger ещё не создан — запомним и залогируем после его инициализации.
    auditNotifyError = errMsg(err);
  }

  const logger = new Logger(normalizeLogLevel(config.logLevel));
  logger.setLogDir(join(dir, "logs"));
  // Диагностика опечаток в ключах i18n — видна только на debug-уровне.
  setMissingKeyReporter((key) => logger.debug(`Missing i18n key: ${key}`));
  if (auditNotifyError) {
    logger.debug(`Audit notifier config skipped: ${auditNotifyError}`);
  }
  logger.debug("MMA bootstrap", {
    version: config.version,
    model: config.model,
  });

  // Синхронизируем бандл-манифест версии пакета в ~/.mma/certifications.json
  // (бандл-записи затирают свои ключи при апдейте; пользовательские сохраняются).
  // Best-effort, молча.
  try {
    const { syncGlobalManifest } = await import("../../modules/certification/manifest");
    const syncResult = syncGlobalManifest();
    if (syncResult.synced) {
      logger.debug("Certification manifest synced from package");
    }
  } catch {
    // Метки сертификации косметические — старт не блокируем никогда.
  }

  return { dir, projectConfigPath, config, legacyDetected, logger };
}
