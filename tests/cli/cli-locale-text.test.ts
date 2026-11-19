// Guard: CLI-текст про политики безопасности и неизвестного провайдера
// локализован, а не берётся из английских литералов данных.
//
// Регресс из стресс-теста (волна 18): `mma security policies` печатал
// «Good security with reasonable flexibility» рядом с русским «Рекомендуется
// для», а `mma provider use nope` — `Unknown provider "nope"` в ru-локали.
import { describe, it, expect } from "vitest";
import { t } from "../../src/i18n/index";
import { getSecurityPolicy } from "../../src/modules/security/security-policies";
import {
  securityPolicyDescription,
  securityPolicyName,
} from "../../src/modules/security/policy-i18n";

describe("локализация CLI-текста", () => {
  it("имя и описание пресета берутся из словаря", () => {
    const strict = getSecurityPolicy("strict");

    for (const key of ["security.policy.strict.name", "security.policy.strict.desc"]) {
      expect(t(key), `ключ ${key} должен быть в словаре`).not.toBe(key);
    }
    expect(securityPolicyName(strict)).toBe(t("security.policy.strict.name"));
    expect(securityPolicyDescription(strict)).toBe(t("security.policy.strict.desc"));
  });

  it("все три пресета имеют ключи имени и описания", () => {
    for (const preset of ["strict", "balanced", "permissive"] as const) {
      const policy = getSecurityPolicy(preset);
      expect(securityPolicyName(policy)).toBe(t(`security.policy.${preset}.name`));
      expect(securityPolicyDescription(policy)).toBe(t(`security.policy.${preset}.desc`));
      // Ключ существует: иначе helper вернёт литерал данных, а t() — сам ключ.
      expect(t(`security.policy.${preset}.desc`)).not.toBe(`security.policy.${preset}.desc`);
    }
  });

  it("неизвестный провайдер сообщает имя через словарь", () => {
    const msg = t("provider.unknown", { name: "nope" });

    expect(msg).not.toBe("provider.unknown");
    expect(msg).toContain("nope");
  });
});
