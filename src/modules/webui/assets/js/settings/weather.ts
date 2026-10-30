// Falling weather for seasonal themes: a thin fixed overlay of emoji particles
// with randomized size, lane, speed and drift. One CSS animation per particle
// on `transform`/`opacity` only, so the main thread stays free and the effect
// is easy to disable under `prefers-reduced-motion`.
const LAYER_ID = "themeWeather";
const PARTICLES: Record<string, { chars: string[]; count: number; size: [number, number] }> = {
  winter: { chars: ["❄️", "❅", "❆"], count: 28, size: [10, 20] },
  autumn: { chars: ["🍁", "🍂", "🍃"], count: 22, size: [14, 26] },
};

let current = "";

function reducedMotion(): boolean {
  return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function layer(): HTMLElement {
  let host = document.getElementById(LAYER_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = LAYER_ID;
    host.className = "wx-layer";
    host.setAttribute("aria-hidden", "true");
    document.body.appendChild(host);
  }
  return host;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Swap the overlay for `theme` (no-op for non-seasonal ids). */
export function applyThemeWeather(theme: string): void {
  if (theme === current) return;
  current = theme;
  const host = layer();
  host.textContent = "";
  const spec = PARTICLES[theme];
  host.hidden = !spec || reducedMotion();
  if (!spec || reducedMotion()) return;

  for (let i = 0; i < spec.count; i++) {
    const p = document.createElement("span");
    p.className = "wx-p";
    p.textContent = spec.chars[Math.floor(Math.random() * spec.chars.length)];
    // Negative delay starts the field already mid-air instead of a visible wave.
    p.style.setProperty("--x", `${rand(1, 99).toFixed(2)}%`);
    p.style.setProperty("--size", `${rand(spec.size[0], spec.size[1]).toFixed(1)}px`);
    p.style.setProperty("--dur", `${rand(9, 22).toFixed(1)}s`);
    p.style.setProperty("--delay", `${rand(-22, 0).toFixed(1)}s`);
    p.style.setProperty("--dx", `${rand(-7, 7).toFixed(1)}vw`);
    p.style.setProperty("--rot", `${rand(-260, 260).toFixed(0)}deg`);
    p.style.setProperty("--o", rand(0.3, 0.65).toFixed(2));
    host.appendChild(p);
  }
}
