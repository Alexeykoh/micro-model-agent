// Локализованные подписи политик безопасности.
//
// Данные политики (`SECURITY_POLICIES`) — английские литералы и одновременно
// контракт в конфиге, поэтому переводим их на выводе, а не в данных. Вынесено
// из `security-policies.ts`: тот файл в allowlist с потолком, который может
// только уменьшаться (правило 6).
import { t } from "../../i18n/index";
import type { SecurityPolicy } from "./security-policies";

/**
 * Локализованное имя пресета. Нет ключа — возвращаем исходное имя, чтобы вывод
 * не превращался в `security.policy.strict.name`.
 */
export function securityPolicyName(policy: SecurityPolicy): string {
  const key = `security.policy.${policy.preset}.name`;
  const text = t(key);
  return text === key ? policy.name : text;
}

/** Локализованное описание пресета (тот же приём, что и у имени). */
export function securityPolicyDescription(policy: SecurityPolicy): string {
  const key = `security.policy.${policy.preset}.desc`;
  const text = t(key);
  return text === key ? policy.description : text;
}
