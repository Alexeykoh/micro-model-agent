/** `?` reveals the compressed keyboard hints on demand. */
export function initHintToggle(): void {
  const btn = document.getElementById("hintMore");
  const meta = document.querySelector<HTMLElement>(".inp-meta");
  if (!btn || !meta) return;
  btn.addEventListener("click", () => {
    const open = meta.classList.toggle("expanded");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  });
}
