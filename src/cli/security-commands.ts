import { Command } from "commander";
import { bootstrap } from "../core/bootstrap";
import { saveConfig } from "../config/config";
import { join, dirname } from "path";
import { homedir } from "os";
import {
  SECURITY_POLICIES,
  applySecurityPolicy,
  getSecurityPolicy,
  type SecurityPolicyPreset,
} from "../modules/security/security-policies";
import { globalAuditNotifier } from "../modules/security/audit-notifier";
import { t } from "../i18n/index";
import { getDefaultChannel } from "../output";

/**
 * Toggle session-file encryption in place: flips `enabled` (and the two
 * per-file flags) while PRESERVING user-set fields already stored in the
 * config (keyPath etc.). Mutates the passed security object.
 */
export function toggleSessionEncryption(security: Record<string, any>, enabled: boolean): void {
  const enc = (security.sessionEncryption ?? {}) as Record<string, any>;
  enc.enabled = enabled;
  enc.encryptHistory = enabled;
  enc.encryptSessionLog = enabled;
  security.sessionEncryption = enc;
}

/**
 * Toggle audit notifications in place: flips `enabled` only, preserving
 * webhookUrl / filePath / minSeverity / eventTypes set by the user.
 */
export function toggleAuditNotifier(security: Record<string, any>, enabled: boolean): void {
  const notifier = (security.auditNotifier ?? {}) as Record<string, any>;
  notifier.enabled = enabled;
  security.auditNotifier = notifier;
}

/**
 * Create security subcommand
 */
export function createSecurityCommand(program: Command): void {
  const securityCmd = program.command("security").description(t("cli.security.description"));

  // security status - show current security configuration
  securityCmd
    .command("status")
    .description(t("cli.security.status"))
    .action(async () => {
      const { config } = await bootstrap();
      const security = (config as any).security || {};
      const bash = security.bash || {};
      const paths = security.paths || {};
      const network = security.network || {};
      const contentScan = security.contentScan || {};
      const rateLimits = security.rateLimits || {};
      const sessionEncryption = security.sessionEncryption || {};
      const auditNotifier = security.auditNotifier || {};

      getDefaultChannel().writeLine(t("cli.security.current_policy"));
      getDefaultChannel().writeLine(
        `  ${t("cli.security.bash_enabled")}: ${bash.blacklist?.length > 0 ? t("cli.yes") : t("cli.no")}`,
      );
      getDefaultChannel().writeLine(
        `  ${t("cli.security.path_validation")}: ${paths.enabled ? t("cli.yes") : t("cli.no")}`,
      );
      getDefaultChannel().writeLine(
        `  ${t("cli.security.network_validation")}: ${network.deniedDomains?.length > 0 || network.allowedDomains?.length > 0 ? t("cli.yes") : t("cli.no")}`,
      );
      getDefaultChannel().writeLine(
        `  ${t("cli.security.content_scanning")}: ${contentScan.enabled ? t("cli.yes") : t("cli.no")}`,
      );
      getDefaultChannel().writeLine(
        `  ${t("cli.security.max_recursion")}: ${security.maxRecursionDepth ?? 3}`,
      );
      getDefaultChannel().writeLine(
        `  ${t("cli.security.max_file_ops")}: ${security.maxFileOperations ?? 100}`,
      );
      getDefaultChannel().writeLine(
        `  ${t("cli.security.rate_limit")}: ${rateLimits.maxRequestsPerMinute ?? 60}/min`,
      );
      getDefaultChannel().writeLine(
        `  ${t("cli.security.session_encryption")}: ${sessionEncryption.enabled ? t("cli.yes") : t("cli.no")}`,
      );
      getDefaultChannel().writeLine(
        `  ${t("cli.security.audit_notifier")}: ${auditNotifier.enabled ? t("cli.yes") : t("cli.no")}`,
      );
    });

  // security policies - manage security policies
  securityCmd
    .command("policies")
    .description(t("cli.security.policies"))
    .action(async () => {
      getDefaultChannel().writeLine(t("cli.security.available_policies"));
      getDefaultChannel().writeLine("");

      for (const [preset, policy] of Object.entries(SECURITY_POLICIES)) {
        if (preset === "custom") continue;

        const marker = " ";
        getDefaultChannel().writeLine(` ${marker}${preset.padEnd(12)}  ${policy.name}`);
        getDefaultChannel().writeLine(`             ${policy.description}`);
        getDefaultChannel().writeLine(
          `             ${t("cli.security.recommended_for")}: ${policy.recommendedFor.join(", ")}`,
        );
        getDefaultChannel().writeLine("");
      }
    });

  // security set-policy - apply a security policy
  securityCmd
    .command("set-policy")
    .argument("<preset>", t("cli.security.preset"))
    .description(t("cli.security.set_policy"))
    .action(async (preset: string) => {
      const configPath = join(homedir(), ".mma", "config.json");
      const { config: appConfig } = await bootstrap();

      const validPresets: SecurityPolicyPreset[] = ["strict", "balanced", "permissive"];
      if (!validPresets.includes(preset as SecurityPolicyPreset)) {
        getDefaultChannel().writeLine(
          t("cli.security.invalid_preset", { presets: validPresets.join(", ") }),
        );
        return;
      }

      const policy = getSecurityPolicy(preset as SecurityPolicyPreset);
      const newSecurityConfig = applySecurityPolicy(preset as SecurityPolicyPreset);

      // Merge with existing config
      (appConfig as any).security = newSecurityConfig;
      saveConfig(appConfig, configPath, dirname(configPath));

      getDefaultChannel().writeLine(t("cli.security.policy_applied", { name: policy.name }));
      getDefaultChannel().writeLine(
        t("cli.security.policy_description", { description: policy.description }),
      );
    });

  // security enable-encryption - enable session file encryption
  securityCmd
    .command("enable-encryption")
    .description(t("cli.security.enable_encryption"))
    .action(async () => {
      const configPath = join(homedir(), ".mma", "config.json");
      const { config: appConfig } = await bootstrap();

      const security = ((appConfig as any).security = (appConfig as any).security || {});
      toggleSessionEncryption(security, true);

      saveConfig(appConfig, configPath, dirname(configPath));
      getDefaultChannel().writeLine(t("cli.security.encryption_enabled"));
    });

  // security disable-encryption - disable session file encryption
  securityCmd
    .command("disable-encryption")
    .description(t("cli.security.disable_encryption"))
    .action(async () => {
      const configPath = join(homedir(), ".mma", "config.json");
      const { config: appConfig } = await bootstrap();

      const security = ((appConfig as any).security = (appConfig as any).security || {});
      toggleSessionEncryption(security, false);

      saveConfig(appConfig, configPath, dirname(configPath));
      getDefaultChannel().writeLine(t("cli.security.encryption_disabled"));
    });

  // security enable-audit - enable audit notifications
  securityCmd
    .command("enable-audit")
    .description(t("cli.security.enable_audit"))
    .action(async () => {
      const configPath = join(homedir(), ".mma", "config.json");
      const { config: appConfig } = await bootstrap();

      const security = ((appConfig as any).security = (appConfig as any).security || {});
      toggleAuditNotifier(security, true);

      saveConfig(appConfig, configPath, dirname(configPath));
      getDefaultChannel().writeLine(t("cli.security.audit_enabled"));
    });

  // security disable-audit - disable audit notifications
  securityCmd
    .command("disable-audit")
    .description(t("cli.security.disable_audit"))
    .action(async () => {
      const configPath = join(homedir(), ".mma", "config.json");
      const { config: appConfig } = await bootstrap();

      const security = ((appConfig as any).security = (appConfig as any).security || {});
      toggleAuditNotifier(security, false);

      saveConfig(appConfig, configPath, dirname(configPath));
      getDefaultChannel().writeLine(t("cli.security.audit_disabled"));
    });

  // security audit-stats - show audit notification statistics
  securityCmd
    .command("audit-stats")
    .description(t("cli.security.audit_stats"))
    .action(async () => {
      const stats = globalAuditNotifier.getStats();

      getDefaultChannel().writeLine(t("cli.security.audit_stats_title"));
      getDefaultChannel().writeLine(`  ${t("cli.security.total_notifications")}: ${stats.total}`);
      getDefaultChannel().writeLine("");
      getDefaultChannel().writeLine(t("cli.security.by_severity"));
      getDefaultChannel().writeLine(`  ${t("cli.security.low")}: ${stats.bySeverity.low}`);
      getDefaultChannel().writeLine(`  ${t("cli.security.medium")}: ${stats.bySeverity.medium}`);
      getDefaultChannel().writeLine(`  ${t("cli.security.high")}: ${stats.bySeverity.high}`);
      getDefaultChannel().writeLine(
        `  ${t("cli.security.critical")}: ${stats.bySeverity.critical}`,
      );
      getDefaultChannel().writeLine("");
      getDefaultChannel().writeLine(t("cli.security.by_type"));
      for (const [type, count] of Object.entries(stats.byType)) {
        if (count > 0) {
          getDefaultChannel().writeLine(`  ${type}: ${count}`);
        }
      }
    });
}
