import { Command } from "commander";
import { bootstrap } from "../core/bootstrap";
import { saveConfig } from "../config/config";
import { join } from "path";
import { homedir } from "os";
import {
  SECURITY_POLICIES,
  applySecurityPolicy,
  getSecurityPolicy,
  type SecurityPolicyPreset,
} from "../modules/security/security-policies";
import { globalAuditNotifier } from "../modules/security/audit-notifier";
import { t } from "../i18n/index";

/**
 * Create security subcommand
 */
export function createSecurityCommand(program: Command): void {
  const securityCmd = program
    .command("security")
    .description(t("cli.security.description"));

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
      
      console.log(t("cli.security.current_policy"));
      console.log(`  ${t("cli.security.bash_enabled")}: ${bash.blacklist?.length > 0 ? t("cli.yes") : t("cli.no")}`);
      console.log(`  ${t("cli.security.path_validation")}: ${paths.denied?.length > 0 ? t("cli.yes") : t("cli.no")}`);
      console.log(`  ${t("cli.security.network_validation")}: ${network.deniedDomains?.length > 0 || network.allowedDomains?.length > 0 ? t("cli.yes") : t("cli.no")}`);
      console.log(`  ${t("cli.security.content_scanning")}: ${contentScan.enabled ? t("cli.yes") : t("cli.no")}`);
      console.log(`  ${t("cli.security.max_recursion")}: ${security.maxRecursionDepth ?? 3}`);
      console.log(`  ${t("cli.security.max_file_ops")}: ${security.maxFileOperations ?? 100}`);
      console.log(`  ${t("cli.security.rate_limit")}: ${rateLimits.maxRequestsPerMinute ?? 60}/min`);
      console.log(`  ${t("cli.security.session_encryption")}: ${sessionEncryption.enabled ? t("cli.yes") : t("cli.no")}`);
      console.log(`  ${t("cli.security.audit_notifier")}: ${auditNotifier.enabled ? t("cli.yes") : t("cli.no")}`);
    });

  // security policies - manage security policies
  securityCmd
    .command("policies")
    .description(t("cli.security.policies"))
    .action(async () => {
      console.log(t("cli.security.available_policies"));
      console.log("");
      
      for (const [preset, policy] of Object.entries(SECURITY_POLICIES)) {
        if (preset === 'custom') continue;
        
        const marker = " ";
        console.log(` ${marker}${preset.padEnd(12)}  ${policy.name}`);
        console.log(`             ${policy.description}`);
        console.log(`             ${t("cli.security.recommended_for")}: ${policy.recommendedFor.join(", ")}`);
        console.log("");
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
      
      const validPresets: SecurityPolicyPreset[] = ['strict', 'balanced', 'permissive'];
      if (!validPresets.includes(preset as SecurityPolicyPreset)) {
        console.log(t("cli.security.invalid_preset", { presets: validPresets.join(", ") }));
        return;
      }
      
      const policy = getSecurityPolicy(preset as SecurityPolicyPreset);
      const newSecurityConfig = applySecurityPolicy(preset as SecurityPolicyPreset);
      
      // Merge with existing config
      (appConfig as any).security = newSecurityConfig;
      saveConfig(appConfig, configPath);
      
      console.log(t("cli.security.policy_applied", { name: policy.name }));
      console.log(t("cli.security.policy_description", { description: policy.description }));
    });

  // security enable-encryption - enable session file encryption
  securityCmd
    .command("enable-encryption")
    .description(t("cli.security.enable_encryption"))
    .action(async () => {
      const configPath = join(homedir(), ".mma", "config.json");
      const { config: appConfig } = await bootstrap();
      
      (appConfig as any).security = (appConfig as any).security || {};
      (appConfig as any).security.sessionEncryption = {
        enabled: true,
        encryptHistory: true,
        encryptSessionLog: true,
      };
      
      saveConfig(appConfig, configPath);
      console.log(t("cli.security.encryption_enabled"));
    });

  // security disable-encryption - disable session file encryption
  securityCmd
    .command("disable-encryption")
    .description(t("cli.security.disable_encryption"))
    .action(async () => {
      const configPath = join(homedir(), ".mma", "config.json");
      const { config: appConfig } = await bootstrap();
      
      (appConfig as any).security = (appConfig as any).security || {};
      (appConfig as any).security.sessionEncryption = {
        enabled: false,
        encryptHistory: false,
        encryptSessionLog: false,
      };
      
      saveConfig(appConfig, configPath);
      console.log(t("cli.security.encryption_disabled"));
    });

  // security enable-audit - enable audit notifications
  securityCmd
    .command("enable-audit")
    .description(t("cli.security.enable_audit"))
    .action(async () => {
      const configPath = join(homedir(), ".mma", "config.json");
      const { config: appConfig } = await bootstrap();
      
      (appConfig as any).security = (appConfig as any).security || {};
      (appConfig as any).security.auditNotifier = {
        enabled: true,
        minSeverity: 'medium',
        eventTypes: ['security_block', 'bash_command', 'file_operation', 'network_request'],
        maxRetries: 3,
        webhookTimeout: 5000,
      };
      
      saveConfig(appConfig, configPath);
      console.log(t("cli.security.audit_enabled"));
    });

  // security disable-audit - disable audit notifications
  securityCmd
    .command("disable-audit")
    .description(t("cli.security.disable_audit"))
    .action(async () => {
      const configPath = join(homedir(), ".mma", "config.json");
      const { config: appConfig } = await bootstrap();
      
      (appConfig as any).security = (appConfig as any).security || {};
      (appConfig as any).security.auditNotifier = {
        enabled: false,
        maxRetries: 3,
        webhookTimeout: 5000,
      };
      
      saveConfig(appConfig, configPath);
      console.log(t("cli.security.audit_disabled"));
    });

  // security audit-stats - show audit notification statistics
  securityCmd
    .command("audit-stats")
    .description(t("cli.security.audit_stats"))
    .action(async () => {
      const stats = globalAuditNotifier.getStats();
      
      console.log(t("cli.security.audit_stats_title"));
      console.log(`  ${t("cli.security.total_notifications")}: ${stats.total}`);
      console.log("");
      console.log(t("cli.security.by_severity"));
      console.log(`  ${t("cli.security.low")}: ${stats.bySeverity.low}`);
      console.log(`  ${t("cli.security.medium")}: ${stats.bySeverity.medium}`);
      console.log(`  ${t("cli.security.high")}: ${stats.bySeverity.high}`);
      console.log(`  ${t("cli.security.critical")}: ${stats.bySeverity.critical}`);
      console.log("");
      console.log(t("cli.security.by_type"));
      for (const [type, count] of Object.entries(stats.byType)) {
        if (count > 0) {
          console.log(`  ${type}: ${count}`);
        }
      }
    });
}
