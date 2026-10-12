/**
 * Контракт браузер-модуля для `ModuleHost` (INV-5/7).
 *
 * Не критичен (без браузера агент работает, веб-тулы деградируют). Держит
 * внешний процесс-бридж и сессию, поэтому объявляет `teardown`. `health()` пока
 * не реализован: дешёвой пробы Chromium нет (проверка playwright живёт в фазе
 * окружения), а подделывать «ok» хуже отсутствия.
 */
import type { ModuleDef } from "../../core/module-host";
import { closeBrowserSession } from "../../tools/browser";

/** Определение браузера: не критичен; teardown закрывает сессию/бридж. */
export function browserModuleDef(): ModuleDef {
  return {
    name: "browser",
    critical: false,
    teardown: () => closeBrowserSession(),
  };
}
