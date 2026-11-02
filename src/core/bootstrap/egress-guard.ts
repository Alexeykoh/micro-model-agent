/**
 * Установка DLP egress-guard'а (E1) для провайдерной фазы. Вынесено в отдельный
 * модуль, чтобы `provider-phase.ts` оставался в пределах ≤300 строк (правило 6).
 *
 * Регистрация глобальная (INV-D10): и активная, и managed-фабрика собирают
 * провайдера через `ProviderManager.build()`, поэтому одна точка покрывает обе.
 */
import type { AppConfig } from "../../config/types";
import { createProviderEgressFactory } from "../../modules/security/data-policy/egress-provider";
import type { PolicyContext } from "../../modules/security/data-policy/context";
import { machinePolicyContext } from "../../modules/security/data-policy/context";
import { setEgressGuard } from "../../modules/providers/sanitizing";
import { resolveBaseDir } from "./workspace-phase";

/**
 * Зарегистрировать фабрику egress-guard'а ДО первой сборки провайдера. Фабрика
 * читает живой конфиг на каждый билд, поэтому `setConfigValue` + `provider.rebuild`
 * подхватывают смену политики.
 */
export function installEgressGuard(
  config: AppConfig,
  configDir: string,
  projectDir?: string,
): void {
  setEgressGuard(
    createProviderEgressFactory({ getConfig: () => config, ctx: policyContext(configDir, projectDir) }),
  );
}

/**
 * Машинный контекст для value-based детекции DLP: реальные корни (workspace,
 * home, доп. корни), имя машины/пользователя и окружение. Источник один —
 * `machinePolicyContext` из модуля data-policy, чтобы web_search и E1-фабрика
 * не расходились в том, что считается машинным путём.
 */
function policyContext(configDir: string, projectDir?: string): PolicyContext {
  return machinePolicyContext(resolveBaseDir(projectDir), configDir);
}
