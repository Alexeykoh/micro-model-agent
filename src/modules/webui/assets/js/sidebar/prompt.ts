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
  /** Почему блок не вошёл/работает неполно (INV-17). */
  reason?: string;
}

interface PromptResponse {
  available: boolean;
  reason?: string;
  text?: string;
  tokenCount?: number;
  /** Бюджет системного промпта; без него показываем только фактический размер. */
  budget?: number;
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

/** Причина исключения из бюджета приходит машинной строкой; показываем по-человечески. */
function reasonText(reason: string | undefined): string {
  const budget = reason ? /^budget:\s*(\d+)\s+tok did not fit/i.exec(reason) : null;
  if (budget) return t("web.sidebar.prompt_reason_budget", { tokens: budget[1] });
  return reason || t("web.sidebar.prompt_reason_unknown");
}

function blockChip(block: PromptBlock): HTMLElement {
  const chip = el("span", "prompt-block" + (block.included ? "" : " excluded"));
  const parts = [block.label, block.priority, String(block.tokens)];
  if (block.included) {
    chip.textContent = parts.join(" · ");
    return chip;
  }
  // Не цвет, а форма + текст: пунктир/⊘ и явное «исключён» читаются без цвета.
  chip.textContent = "⊘ " + parts.join(" · ") + " · " + t("web.sidebar.prompt_excluded");
  const reason = t("web.sidebar.prompt_excluded_reason", { reason: reasonText(block.reason) });
  chip.title = reason;
  chip.setAttribute("aria-label", chip.textContent + " — " + reason);
  return chip;
}

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
  const blocks = data.blocks ?? [];
  const included = blocks.filter((b) => b.included);
  const excluded = blocks.filter((b) => !b.included);
  const tokens = String(data.tokenCount ?? 0);
  const meta = [
    typeof data.budget === "number"
      ? t("web.sidebar.prompt_budget", { tokens, budget: String(data.budget) })
      : t("web.sidebar.prompt_tokens", { tokens }),
  ];
  if (blocks.length > 0) {
    meta.push(t("web.sidebar.prompt_included_count", { count: String(included.length) }));
    if (excluded.length > 0) {
      meta.push(t("web.sidebar.prompt_excluded_count", { count: String(excluded.length) }));
    }
  }
  metaEl.textContent = meta.join(" · ");
  // Сначала то, что реально ушло модели; выпавшее — в конце, чтобы не рвать
  // ряд включённых блоков. `data.excluded` (содержимое) больше не рендерим:
  // единственный источник чипов — `blocks[]` (иначе дубли и огромные подписи).
  for (const block of [...included, ...excluded]) blocksEl.appendChild(blockChip(block));
  if (excluded.length > 0) {
    blocksEl.appendChild(el("div", "prompt-hint", t("web.sidebar.prompt_excluded_hint")));
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
