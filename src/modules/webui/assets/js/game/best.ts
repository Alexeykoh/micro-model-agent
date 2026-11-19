// Best score for MMART flight. localStorage is only a cache: private mode or a
// full quota must never break the game.
const KEY = "mma-game-best";

export function loadBest(): number {
  try {
    return Math.max(0, Number(localStorage.getItem(KEY)) || 0);
  } catch {
    return 0;
  }
}

export function saveBest(value: number): void {
  try {
    localStorage.setItem(KEY, String(value));
  } catch {
    /* the record just does not survive the visit */
  }
}
