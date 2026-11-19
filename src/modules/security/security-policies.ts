// Менеджер политик безопасности поверх готовых пресетов strict/balanced/permissive.
//
// Сами пресеты — в `security-policy-presets.ts`, литеральные таблицы — в
// `security-policy-tables.ts` (правило #1: ≤300 строк/файл). Публичный API
// модуля остаётся здесь: реэкспорт пресетов + менеджер + глобальные хелперы.
import type { SecurityConfig } from "../../config/types";
import { mergeSecurityConfig } from "../../config/security";
import {
  BALANCED_POLICY,
  SECURITY_POLICIES,
  type SecurityPolicy,
  type SecurityPolicyPreset,
} from "./security-policy-presets";

export {
  BALANCED_POLICY,
  PERMISSIVE_POLICY,
  SECURITY_POLICIES,
  STRICT_POLICY,
} from "./security-policy-presets";
export type { SecurityPolicy, SecurityPolicyPreset } from "./security-policy-presets";

/** Менеджер политик безопасности (текущая + кастом). */
export class SecurityPolicyManager {
  private currentPolicy: SecurityPolicyPreset = "balanced";
  private customConfig: Partial<SecurityConfig> = {};

  /** Все доступные политики. */
  getPolicies(): SecurityPolicy[] {
    return Object.values(SECURITY_POLICIES);
  }

  /** Политика по имени (неизвестная — balanced). */
  getPolicy(preset: SecurityPolicyPreset): SecurityPolicy {
    return SECURITY_POLICIES[preset] || SECURITY_POLICIES.balanced;
  }

  /** Текущая политика (custom — с кастомным конфигом). */
  getCurrentPolicy(): SecurityPolicy {
    if (this.currentPolicy === "custom") {
      return {
        ...SECURITY_POLICIES.custom,
        config: this.customConfig,
      };
    }
    return this.getPolicy(this.currentPolicy);
  }

  /** Назначить текущую политику. */
  setPolicy(preset: SecurityPolicyPreset): void {
    this.currentPolicy = preset;
  }

  /** Задать кастомный конфиг (переключает на 'custom'). */
  setCustomConfig(config: Partial<SecurityConfig>): void {
    this.customConfig = config;
    this.currentPolicy = "custom";
  }

  /** Текущий security-конфиг (политика + мерж дефолтов). */
  getConfig(): SecurityConfig {
    const policy = this.getCurrentPolicy();
    return mergeSecurityConfig({
      ...policy.config,
      ...(this.currentPolicy === "custom" ? this.customConfig : {}),
    });
  }

  /** Применить политику с опциональными оверрайдами; вернуть смерженный конфиг. */
  applyPolicy(
    preset: SecurityPolicyPreset,
    customOverrides?: Partial<SecurityConfig>,
  ): SecurityConfig {
    this.setPolicy(preset);
    if (customOverrides) {
      this.customConfig = customOverrides;
      this.currentPolicy = "custom";
    }
    return this.getConfig();
  }

  /** Рекомендованная политика для кейса (иначе — balanced). */
  getRecommendation(useCase: string): SecurityPolicy {
    for (const policy of this.getPolicies()) {
      if (policy.recommendedFor.includes(useCase)) {
        return policy;
      }
    }
    return BALANCED_POLICY;
  }

  /** Разрешает ли текущая политика действие (bash/file_access/network). */
  allowsAction(
    action: string,
    context?: { type: string; path?: string; command?: string },
  ): boolean {
    const config = this.getConfig();

    switch (action) {
      case "bash":
        if (context?.command) {
          const cmd = context.command.split(" ")[0];
          return !config.bash.blacklist.includes(cmd);
        }
        return true;

      case "file_access":
        if (context?.path) {
          for (const denied of config.paths.denied) {
            if (context.path.includes(denied.replace("*", ""))) {
              return false;
            }
          }
        }
        return true;

      case "network":
        if (context?.path) {
          for (const denied of config.network.deniedDomains) {
            if (context.path.includes(denied.replace("*", ""))) {
              return false;
            }
          }
        }
        return true;

      default:
        return true;
    }
  }

  /** Посравнить две политики по ключам конфига. */
  comparePolicies(
    policy1: SecurityPolicyPreset,
    policy2: SecurityPolicyPreset,
  ): Record<string, { policy1: unknown; policy2: unknown }> {
    const config1 = this.getPolicy(policy1).config;
    const config2 = this.getPolicy(policy2).config;

    const comparison: Record<string, { policy1: unknown; policy2: unknown }> = {};

    const keys = new Set([...Object.keys(config1), ...Object.keys(config2)]);
    for (const key of keys) {
      comparison[key] = {
        policy1: config1[key as keyof SecurityConfig],
        policy2: config2[key as keyof SecurityConfig],
      };
    }

    return comparison;
  }
}

/** Глобальный менеджер политик. */
export const globalSecurityPolicyManager = new SecurityPolicyManager();

/** Создать менеджер политик. */
export function createSecurityPolicyManager(): SecurityPolicyManager {
  return new SecurityPolicyManager();
}

/** Политика по имени через глобальный менеджер. */
export function getSecurityPolicy(preset: SecurityPolicyPreset): SecurityPolicy {
  return globalSecurityPolicyManager.getPolicy(preset);
}

/** Применить политику через глобальный менеджер. */
export function applySecurityPolicy(
  preset: SecurityPolicyPreset,
  customOverrides?: Partial<SecurityConfig>,
): SecurityConfig {
  return globalSecurityPolicyManager.applyPolicy(preset, customOverrides);
}
