/**
 * Причина деградации критика → короткая строка для ленты.
 *
 * Гейт fail-open: «критик не ответил» не блокирует ответ, но и не должен
 * выглядеть как «проверил и сказал ок». Техническая причина
 * (`call_timeout (125000ms)`, `unparseable_verdict (pass-1): …`) остаётся в
 * `session.jsonl` и app-логе; в чат идёт класс причины по STYLE (человеческие
 * слова, одна короткая строка). См. docs/specs/2026-10-24-critic-degrade-feed-design.md.
 */
import { t } from "../../i18n/index";

/** Класс отказа верификации: то, что пользователь видит вместо технической строки. */
export type CriticDegradeClass = "timeout" | "unparseable" | "checks" | "llm" | "none";

/**
 * Префикс причины (как его пишет клиент критика в `CRITIC_DEGRADED_PREFIX`)
 * → класс. Порядок не важен: префиксы не пересекаются.
 */
const CLASS_BY_PREFIX: ReadonlyArray<readonly [string, CriticDegradeClass]> = [
  ["call_timeout", "timeout"],
  ["unparseable_verdict", "unparseable"],
  ["checks_loop_failed", "checks"],
  ["llm_error", "llm"],
];

/**
 * Классифицирует причину деградации. Неизвестная/пустая причина — `none`:
 * гейт видел `null`, но клиент причины не сообщил (или упал сам verify).
 */
export function criticDegradeClass(reason: string | undefined): CriticDegradeClass {
  const text = (reason ?? "").trim();
  for (const [prefix, cls] of CLASS_BY_PREFIX) {
    if (text.startsWith(prefix)) return cls;
  }
  return "none";
}

/** Готовая статус-строка ленты для деградации с этой причиной. */
export function criticDegradeLine(reason: string | undefined): string {
  return t("ui.critic_skipped", { reason: t(`ui.critic_reason.${criticDegradeClass(reason)}`) });
}
