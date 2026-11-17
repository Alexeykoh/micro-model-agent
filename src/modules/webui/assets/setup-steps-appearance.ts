/** Шаг 3.3: тема, режим оформления и звуки уведомлений. */
import { UI_THEMES } from "./js/settings/themes.js";
import { playCue } from "./js/sounds.js";
import type { SetupContext } from "./setup-context.js";
import { h, stepBody } from "./setup-dom.js";
import { tr } from "./setup-i18n.js";

const BODY_THEMES = UI_THEMES.map((t) => t.id).filter((id) => id !== "flat");

/** Тема применяется сразу: класс на body + зеркало в localStorage. */
export function applyThemePreview(theme: string, mode: string): void {
  try {
    localStorage.setItem("mma-ui-theme", theme);
    localStorage.setItem("mma-theme", mode);
  } catch {
    /* приватный режим: превью всё равно применится */
  }
  for (const id of BODY_THEMES) document.body.classList.toggle(id, id === theme);
  const light =
    mode === "light" ||
    (mode === "auto" &&
      !!window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: light)").matches);
  document.body.classList.toggle("light", light);
  document.documentElement.style.colorScheme = light ? "light" : "dark";
}

export function renderAppearance(ctx: SetupContext): HTMLElement {
  const box = stepBody("appearance");
  box.appendChild(themeBlock(ctx));
  box.appendChild(modeBlock(ctx));
  box.appendChild(effectsBlock(ctx));
  box.appendChild(soundsBlock(ctx));
  return box;
}

function themeBlock(ctx: SetupContext): HTMLElement {
  const block = h("div", "setup-block");
  block.appendChild(h("div", "setup-block-title", tr("web.setup.appearance.theme")));
  const grid = h("div", "setup-themes");
  UI_THEMES.forEach((theme) => {
    const on = ctx.state.answers.theme === theme.id;
    const btn = h("button", "setup-theme" + (on ? " on" : ""));
    btn.type = "button";
    btn.setAttribute("aria-pressed", String(on));
    btn.title = tr("web.settings.theme." + theme.id);
    const swatch = h("span", "setup-theme-swatch");
    swatch.style.background = `linear-gradient(135deg, ${theme.colors.join(", ")})`;
    btn.appendChild(swatch);
    btn.appendChild(h("span", "setup-theme-name", tr("web.settings.theme." + theme.id)));
    btn.addEventListener("click", () => {
      ctx.state.answers.theme = theme.id;
      applyThemePreview(theme.id, ctx.state.answers.themeMode);
      ctx.render();
    });
    grid.appendChild(btn);
  });
  block.appendChild(grid);
  return block;
}

function modeBlock(ctx: SetupContext): HTMLElement {
  const block = h("div", "setup-block");
  block.appendChild(h("div", "setup-block-title", tr("web.setup.appearance.mode")));
  const row = h("div", "setup-seg");
  for (const mode of ["dark", "light", "auto"] as const) {
    const on = ctx.state.answers.themeMode === mode;
    const btn = h(
      "button",
      "setup-seg-opt" + (on ? " on" : ""),
      tr("web.setup.appearance.mode_" + mode),
    );
    btn.type = "button";
    btn.setAttribute("aria-pressed", String(on));
    btn.addEventListener("click", () => {
      ctx.state.answers.themeMode = mode;
      applyThemePreview(ctx.state.answers.theme, mode);
      ctx.render();
    });
    row.appendChild(btn);
  }
  block.appendChild(row);
  return block;
}

function effectsBlock(ctx: SetupContext): HTMLElement {
  const block = h("div", "setup-block");
  const label = h("label", "setup-toggle");
  const cb = h("input");
  cb.type = "checkbox";
  cb.checked = Boolean(ctx.state.answers.themeEffects);
  cb.addEventListener("change", () => {
    ctx.state.answers.themeEffects = cb.checked;
    ctx.render();
  });
  label.appendChild(cb);
  const texts = h("span", "setup-toggle-texts");
  texts.appendChild(h("span", "t", tr("web.setup.appearance.effects")));
  texts.appendChild(h("span", "d", tr("web.setup.appearance.effects_desc")));
  label.appendChild(texts);
  block.appendChild(label);
  return block;
}

function soundsBlock(ctx: SetupContext): HTMLElement {
  const sounds = ctx.state.answers.sounds;
  const block = h("div", "setup-block");
  block.appendChild(h("div", "setup-block-title", tr("web.setup.appearance.sounds")));
  block.appendChild(soundsToggle(ctx, "enabled", "web.setup.appearance.sounds_master", ""));

  const details = h("div", "setup-sounds-details");
  details.appendChild(soundsToggle(ctx, "done", "web.setup.appearance.sounds_done", ""));
  details.appendChild(soundsToggle(ctx, "question", "web.setup.appearance.sounds_question", ""));
  details.appendChild(soundsToggle(ctx, "failed", "web.setup.appearance.sounds_failed", ""));
  details.appendChild(volumeRow(ctx));
  details.classList.toggle("off", !sounds.enabled);
  block.appendChild(details);
  return block;
}

function soundsToggle(
  ctx: SetupContext,
  key: "enabled" | "done" | "question" | "failed",
  labelKey: string,
  descKey: string,
): HTMLElement {
  const label = h("label", "setup-toggle");
  const cb = h("input");
  cb.type = "checkbox";
  cb.checked = Boolean(ctx.state.answers.sounds[key]);
  cb.addEventListener("change", () => {
    ctx.state.answers.sounds[key] = cb.checked;
    ctx.render();
  });
  label.appendChild(cb);
  const texts = h("span", "setup-toggle-texts");
  texts.appendChild(h("span", "t", tr(labelKey)));
  if (descKey) texts.appendChild(h("span", "d", tr(descKey)));
  label.appendChild(texts);
  return label;
}

function volumeRow(ctx: SetupContext): HTMLElement {
  const row = h("div", "setup-volume");
  const input = h("input", "setup-range");
  input.type = "range";
  input.min = "0";
  input.max = "100";
  input.step = "5";
  input.value = String(ctx.state.answers.sounds.volume);
  const value = h("span", "setup-volume-val", ctx.state.answers.sounds.volume + "%");
  input.addEventListener("input", () => {
    ctx.state.answers.sounds.volume = parseInt(input.value, 10) || 0;
    value.textContent = ctx.state.answers.sounds.volume + "%";
  });
  const test = h("button", "setup-btn", tr("web.setup.appearance.sounds_test"));
  test.type = "button";
  test.addEventListener("click", () => {
    playCue("done", ctx.state.answers.sounds.volume);
  });
  row.appendChild(h("span", "setup-label", tr("web.setup.appearance.sounds_volume")));
  row.appendChild(input);
  row.appendChild(value);
  row.appendChild(test);
  return row;
}
