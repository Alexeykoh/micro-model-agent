/** Шаг 3.3: тема, режим оформления и звуки уведомлений. */
import { UI_THEMES } from "./js/settings/themes.js";
import { playCue } from "./js/sounds.js";
import type { SetupContext } from "./setup-context.js";
import { h, stepBody } from "./setup-dom.js";
import { tr } from "./setup-i18n.js";
import { toggleRow } from "./setup-switch.js";

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
  block.appendChild(
    toggleRow(
      ctx.state.answers.themeEffects,
      tr("web.setup.appearance.effects"),
      tr("web.setup.appearance.effects_desc"),
      (next) => {
        ctx.state.answers.themeEffects = next;
      },
    ),
  );
  return block;
}

function soundsBlock(ctx: SetupContext): HTMLElement {
  const sounds = ctx.state.answers.sounds;
  const block = h("div", "setup-block");
  block.appendChild(h("div", "setup-block-title", tr("web.setup.appearance.sounds")));

  const details = h("div", "setup-sounds-details");
  details.appendChild(
    toggleRow(sounds.done, tr("web.setup.appearance.sounds_done"), "", (next) => {
      ctx.state.answers.sounds.done = next;
    }),
  );
  details.appendChild(
    toggleRow(sounds.question, tr("web.setup.appearance.sounds_question"), "", (next) => {
      ctx.state.answers.sounds.question = next;
    }),
  );
  details.appendChild(
    toggleRow(sounds.failed, tr("web.setup.appearance.sounds_failed"), "", (next) => {
      ctx.state.answers.sounds.failed = next;
    }),
  );
  details.appendChild(volumeRow(ctx));
  details.classList.toggle("off", !sounds.enabled);

  block.appendChild(
    toggleRow(sounds.enabled, tr("web.setup.appearance.sounds_master"), "", (next) => {
      ctx.state.answers.sounds.enabled = next;
      details.classList.toggle("off", !next);
    }),
  );
  block.appendChild(details);
  return block;
}

/** Громкость как в настройках: − значение +, без range-ползунка. */
function volumeRow(ctx: SetupContext): HTMLElement {
  const row = h("div", "setup-volume");
  row.appendChild(h("span", "setup-label", tr("web.setup.appearance.sounds_volume")));

  const ctl = h("div", "volume-ctl");
  const minus = h("button", "volume-btn", "−");
  minus.type = "button";
  minus.setAttribute("aria-label", tr("web.setup.appearance.sounds_less"));
  const value = h("input");
  value.type = "text";
  value.readOnly = true;
  value.value = ctx.state.answers.sounds.volume + "%";
  value.setAttribute("aria-label", tr("web.setup.appearance.sounds_volume"));
  const plus = h("button", "volume-btn", "+");
  plus.type = "button";
  plus.setAttribute("aria-label", tr("web.setup.appearance.sounds_more"));

  const apply = (n: number): void => {
    const clamped = Math.max(0, Math.min(100, Math.round(n / 10) * 10));
    ctx.state.answers.sounds.volume = clamped;
    value.value = clamped + "%";
    playCue("done", clamped);
  };
  minus.addEventListener("click", () => apply(ctx.state.answers.sounds.volume - 10));
  plus.addEventListener("click", () => apply(ctx.state.answers.sounds.volume + 10));
  ctl.appendChild(minus);
  ctl.appendChild(value);
  ctl.appendChild(plus);
  row.appendChild(ctl);

  const test = h("button", "setup-btn", tr("web.setup.appearance.sounds_test"));
  test.type = "button";
  test.addEventListener("click", () => {
    playCue("done", ctx.state.answers.sounds.volume);
  });
  row.appendChild(test);
  return row;
}
