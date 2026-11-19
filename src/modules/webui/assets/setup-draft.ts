/** Черновик визарда в localStorage: переживает перезагрузку вкладки, без ключа. */
import { STEPS, type SetupState } from "./setup-state.js";

const KEY = "mma-setup-draft-v1";

export interface SetupDraft {
  v: 1;
  step: number;
  answers: Record<string, unknown>;
}

/** Сохраняет ответы (кроме `apiKey`) и текущий шаг. Не бросает. */
export function saveDraft(state: SetupState): void {
  try {
    const answers: Record<string, unknown> = { ...state.answers };
    delete answers.apiKey;
    const draft: SetupDraft = { v: 1, step: state.step, answers };
    localStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    /* приватный режим / переполнение: черновик просто не сохранится */
  }
}

/** Читает черновик; битые данные и чужая версия отбрасываются. */
export function loadDraft(): SetupDraft | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SetupDraft> | null;
    if (!parsed || parsed.v !== 1 || typeof parsed.answers !== "object" || !parsed.answers) {
      return null;
    }
    const step =
      typeof parsed.step === "number" && Number.isInteger(parsed.step)
        ? Math.max(0, Math.min(STEPS.length - 1, parsed.step))
        : 0;
    return { v: 1, step, answers: parsed.answers as Record<string, unknown> };
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* игнорируем */
  }
}
