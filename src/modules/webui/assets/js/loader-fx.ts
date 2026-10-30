// Per-state contents for the mascot's effect layer. CSS owns the motion; this
// module only fills `.fx i` with the few glyphs that need text (letters for
// typing, pass/fail marks for tests). Kept separate from `loader.ts` so the
// face factory stays small and the state table is easy to scan.

const TYPE_CHARS = ["a", "b", "c", "d", "e", "{", "}", "<", ">", "/", ";", "1", "0"];
const FX_TEXT: Record<string, string[]> = {
  tests: ["✓", "✗", "✓", "✗"],
  error: ["✕", "✕"],
  done: ["✓", "✦", "•"],
  check: ["<", ">"],
};

/** Fills the face's `.fx` slots for `state` (idempotent per state). */
export function populateFx(face: HTMLElement, state: string): void {
  if (face.dataset.fx === state) return;
  face.dataset.fx = state;
  const items = face.querySelectorAll<HTMLElement>(".fx i");
  const pool = state === "type" ? TYPE_CHARS : FX_TEXT[state] || [];
  items.forEach((item, i) => {
    item.textContent = pool.length
      ? pool[(i + Math.floor(Math.random() * pool.length)) % pool.length]
      : "";
  });
}
