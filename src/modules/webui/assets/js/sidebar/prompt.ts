// System-prompt popup for the Trace tab: full text + block composition.
// Read-only and on demand — the prompt is fetched only when the button is
// clicked, never on every Trace render.
import { api } from "../api.js";
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { session } from "../store.js";

interface PromptBlock {
  label: string;
  priority: string;
  tokens: number;
  included: boolean;
}

interface PromptResponse {
  available: boolean;
  reason?: string;
  text?: string;
  tokenCount?: number;
  excluded?: string[];
  blocks?: PromptBlock[];
}

const overlay = document.getElementById("promptOverlay");
const closeBtn = document.getElementById("promptClose");
const titleEl = document.getElementById("promptTitle");
const metaEl = document.getElementById("promptMeta");
const blocksEl = document.getElementById("promptBlocks");
const textEl = document.getElementById("promptText");
const openBtn = document.getElementById("tracePromptBtn");

function render(data: PromptResponse | null): void {
  if (!metaEl || !blocksEl || !textEl) return;
  metaEl.textContent = "";
  blocksEl.textContent = "";
  textEl.textContent = "";
  if (!data || !data.available) {
    metaEl.textContent = data?.reason === "no_active_runner"
      ? t("web.sidebar.prompt_no_runner")
      : t("web.sidebar.prompt_error");
    return;
  }
  metaEl.textContent = t("web.sidebar.prompt_tokens", { tokens: String(data.tokenCount ?? 0) });
  for (const block of data.blocks ?? []) {
    const chip = el("span", "prompt-block" + (block.included ? "" : " excluded"));
    chip.textContent = `${block.label} · ${block.priority} · ${block.tokens}`;
    blocksEl.appendChild(chip);
  }
  for (const label of data.excluded ?? []) {
    const chip = el("span", "prompt-block excluded");
    chip.textContent = `${label} · ${t("web.sidebar.prompt_excluded")}`;
    blocksEl.appendChild(chip);
  }
  textEl.textContent = data.text ?? "";
}

async function load(): Promise<void> {
  const id = session.activeSessionId;
  if (!id) {
    render(null);
    return;
  }
  const r = await api<PromptResponse>(
    "/api/sessions/" + encodeURIComponent(id) + "/system-prompt",
  );
  render(r.ok ? r.data : null);
}

function close(): void {
  overlay?.classList.remove("open");
}

export function applyPromptI18n(): void {
  if (titleEl) titleEl.textContent = t("web.sidebar.prompt_title");
  if (openBtn) openBtn.textContent = t("web.sidebar.prompt_open");
  if (closeBtn) closeBtn.textContent = "✕";
}

export function initPromptPopup(): void {
  if (!overlay || !openBtn) return;
  applyPromptI18n();
  openBtn.addEventListener("click", () => {
    overlay.classList.add("open");
    render(null);
    void load();
  });
  closeBtn?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("open")) close();
  });
}
