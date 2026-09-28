// Применение ответов first-run визарда на загруженный конфиг (единый путь записи).
/**
 * Применение ответов first-run визарда на загруженный конфиг.
 * Общий для терминального визарда (`src/cli/setup-order.ts` реэкспортит) и
 * браузерного (`src/modules/webui/setup-api.ts`) — единый путь записи в `AppConfig`.
 */
import type { AppConfig } from "../../config/types";
import type { SetupAnswers } from "./answers";

/** Команды в довесок к bash-blacklist, если визард включил блок. */
export const SECURITY_BASH_BLOCKLIST = [
  "rm",
  "dd",
  "chmod",
  "wget",
  "curl",
  "scp",
  "ssh",
  "nc",
  "netcat",
  "sudo",
  "su",
  "kill",
  "pkill",
  "killall",
  "shutdown",
  "reboot",
];

/**
 * Применить ответы first-run визарда на загруженный конфиг.
 * Провайдер заменяется **новым объектом**, а не мутируется на месте: `loadConfig`
 * может повесить сессионный `MMA_PROVIDER_*` env-оверрайд, чей `envValue`
 * указывает на загруженный объект `config.provider`. `stripEnvOverrides` в
 * `saveConfig` матчит этот объект по identity и откатил бы весь провайдер к
 * env/дефолту, молча потеряв провайдер/URL/ключ визарда. Замена объекта
 * сохраняет протухшую identity оверрайда — вычищается только env-ключ, а ответы
 * персистятся. Активная запись `provider.entries[]` тоже переписывается
 * (type/baseUrl/apiKey и окно контекста), соседи и их тюнинг целы.
 */
export function applyAnswersToConfig(config: AppConfig, a: SetupAnswers): AppConfig {
  config.provider = {
    ...config.provider,
    type: a.provider,
    baseUrl: a.apiBase,
    apiKey: a.apiKey,
  };
  config.model = a.model;
  config.contextWindow = a.contextWindow;
  config.maxToolIterations = a.maxToolIterations;
  config.locale = a.locale;
  // Мультиконфиги резолвят активный провайдер из `entries[]`, так что ответы
  // пишутся на активную запись — без потери соседей и тюнинга записи
  // (cache, retry, rateLimits). Осознанный кастомный label сохраняется,
  // generic/дефолтный заменяется.
  if ((config.provider.entries?.length ?? 0) > 0) {
    const entries = config.provider.entries ?? [];
    const activeName =
      config.provider.active || entries[0]?.label || entries[0]?.type;
    const idx = entries.findIndex((e) => e.label === activeName || e.type === activeName);
    const target = idx >= 0 ? idx : 0;
    const current = entries[target];
    const keepLabel = Boolean(current.label && current.label !== current.type);
    const updated = {
      ...current,
      type: a.provider,
      baseUrl: a.apiBase,
      apiKey: a.apiKey,
      contextWindow: a.contextWindow,
      ...(keepLabel ? {} : { label: a.provider }),
    };
    const next = entries.slice();
    next[target] = updated;
    config.provider.entries = next;
    config.provider.active = updated.label || updated.type;
  }
  if (config.security) {
    config.security.enabled = true;
    config.security.bash.enabled = true;
    config.security.bash.blockDangerousFlags =
      a.securityFlagsBlock || config.security.bash.blockDangerousFlags;
    if (a.securityBashBlock) {
      config.security.bash.blacklist = [
        ...new Set([...config.security.bash.blacklist, ...SECURITY_BASH_BLOCKLIST]),
      ];
    }
    config.security.paths.enabled = a.securityPathsRestrict;
  }
  return config;
}
