/**
 * Контракт браузер-модуля для `ModuleHost` (INV-2/5/7).
 *
 * Не критичен (без браузера агент работает, веб-тулы деградируют). Держит
 * внешний процесс-бридж и сессию, поэтому объявляет `teardown`. `health()` —
 * проба Chromium в `setup()` (`probe()`): не установлен → degraded с командой.
 */
import type { ModuleDef } from "../../core/module-host";
import { closeBrowserSession } from "../../tools/browser";
import type { BrowserModule } from "./module";

/** Определение браузера: не критичен; teardown закрывает сессию/бридж. */
export function browserModuleDef(browser: BrowserModule): ModuleDef {
  return {
    name: "browser",
    critical: false,
    setup: () => browser.probe(),
    teardown: () => closeBrowserSession(),
    health: () => browser.health(),
    tools: () => browser.getToolDefinitions(),
    promptBlocks: () => {
      const block = browser.getSystemPromptBlock();
      return block ? [block] : null;
    },
    hooks: () => browser.getPlugin(),
  };
}
