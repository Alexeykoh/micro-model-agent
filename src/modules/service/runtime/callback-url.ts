/**
 * Политика `callbackUrl` webhook'а (W10.4): схема + запрет приватных адресов.
 *
 * `checkOutboundUrl` (W13) закрывает SSRF по IP/домену; здесь добавляется
 * требование `https`, потому что тело webhook'а содержит Job-объект с
 * результатом хода. `http` допустим только для loopback и только с явным
 * `service.webhookAllowHttp` (и, как следствие, `allowPrivateOutbound`).
 */
import type { NetworkSecurityConfig } from "../../../config/types";
import type { Diagnostic } from "../../../output/types";
import { checkOutboundUrl } from "../../security/outbound-policy";
import { isLoopback } from "../../webui/util";

export interface CallbackPolicy {
  networkConfig?: NetworkSecurityConfig;
  /** Разрешить `http` для loopback (`service.webhookAllowHttp`). */
  allowHttp?: boolean;
  /** Операция для диагностики (по умолчанию `service.callback`). */
  operation?: string;
  onDiagnostic?: (diag: Diagnostic) => void;
}

/** Проверяет адрес webhook'а; `reason` заполнен только при отказе. */
export function checkCallbackUrl(
  url: string,
  policy: CallbackPolicy = {},
): { allowed: boolean; reason?: string } {
  const deny = (reason: string): { allowed: false; reason: string } => {
    policy.onDiagnostic?.({
      source: "module:service",
      operation: policy.operation ?? "service.callback",
      kind: "blocked",
      cause: reason,
      recoverable: false,
    });
    return { allowed: false, reason };
  };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return deny(`invalid URL: ${url}`);
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "https:" && scheme !== "http:") {
    return deny(`scheme "${scheme}" is not allowed`);
  }
  if (scheme === "http:" && !(policy.allowHttp && isLoopback(parsed.hostname))) {
    return deny("https required (http is allowed only for loopback with service.webhookAllowHttp)");
  }
  const check = checkOutboundUrl(url, "module:service", {
    ...(policy.networkConfig ? { networkConfig: policy.networkConfig } : {}),
    operation: policy.operation ?? "service.callback",
    ...(policy.onDiagnostic ? { onDiagnostic: policy.onDiagnostic } : {}),
  });
  return check.allowed ? { allowed: true } : { allowed: false, reason: check.reason };
}
