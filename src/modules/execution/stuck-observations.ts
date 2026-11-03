/**
 * Сырые наблюдения детектора застревания: bash-прогоны и сигнатуры ошибок.
 *
 * Вынесено из `stuck-detector.ts` (правило 6): запись и чтение фактов без
 * выводов о застревании. Предикаты и recovery-тексты живут в `stuck-tracker.ts`
 * и `stuck-recovery.ts`.
 */
import { normalizeErrorSignature } from "./stuck-signals";

/**
 * Окно bash-попыток: сколько последних фейлов считается флейлингом.
 *
 * Bash-флейлинг: ≥BASH_FLAIL_THRESHOLD фейлов в последних BASH_FLAIL_WINDOW
 * bash-попытках, независимо от перемежающихся успехов. Per-word hard-stop
 * (bash.ts) обходится ротацией команд (wc → cat → Get-Content → …); окно
 * ловит саму ротацию (было в ses_mt4x3zbo: 8 фейловых shell-уловок за ~12
 * итераций при подсчёте/склейке файлов на Windows).
 */
const BASH_FLAIL_WINDOW = 6;
const BASH_FLAIL_THRESHOLD = 4;

/** Наблюдения: bash-вывод/попытки и счётчики сигнатур ошибок. */
export class StuckObservations {
  webSearchThreshold: number;
  lastBashCommand = "";
  lastBashOutput = "";
  emptyBashRunCount = 0;
  bashRecent: boolean[] = [];
  errorSignatureCounts: Map<string, number> = new Map();
  searchedErrorSignatures: Set<string> = new Set();

  constructor(webSearchThreshold = 5) {
    this.webSearchThreshold = webSearchThreshold;
  }

  /**
   * Записывает КАЖДЫЙ вызов bash (успех или нет): детекция рассуждает о
   * повторных прогонах с пустым выводом, проблемах entry-point и ошибках
   * платформы (PowerShell-командлеты в cmd.exe, bash-heredoc'и, …).
   */
  recordBashOutput(command: string, output: string): void {
    const trimmed = output.trim();
    if (command === this.lastBashCommand && !trimmed) {
      this.emptyBashRunCount++;
    } else {
      this.emptyBashRunCount = 0;
    }
    this.lastBashCommand = command;
    this.lastBashOutput = output;
  }

  /** Исход одной bash-попытки (успех/фейл) — для детекции флейлинга. */
  recordBashAttempt(success: boolean): void {
    this.bashRecent.push(success);
    if (this.bashRecent.length > BASH_FLAIL_WINDOW) this.bashRecent.shift();
  }

  /** True, если свежие bash-попытки в массе фейлятся — модель флейлит. */
  hasBashFlailing(): boolean {
    if (this.bashRecent.length < BASH_FLAIL_THRESHOLD) return false;
    let failures = 0;
    for (const ok of this.bashRecent) if (!ok) failures++;
    return failures >= BASH_FLAIL_THRESHOLD;
  }

  /** Запоминает сигнатуру ошибки тула (вход автопоиска в вебе). */
  recordErrorSignature(toolName: string, output?: string): void {
    const sig = normalizeErrorSignature(toolName, output);
    if (sig) {
      this.errorSignatureCounts.set(sig, (this.errorSignatureCounts.get(sig) || 0) + 1);
    }
  }

  /**
   * Первая сигнатура ошибки, чей счётчик повторов достиг порога веб-поиска и
   * которая ЕЩЁ не искалась (или размаркирована для ретрая). Именно она
   * триггерит автопоиск — не итерации и не per-tool счётчик ошибок.
   */
  getRepeatedErrorSignature(): string | null {
    for (const [sig, count] of this.errorSignatureCounts) {
      if (count >= this.webSearchThreshold && !this.searchedErrorSignatures.has(sig)) {
        return sig;
      }
    }
    return null;
  }

  /** Счётчик повторов сигнатуры ошибки. */
  getErrorSignatureCount(sig: string): number {
    return this.errorSignatureCounts.get(sig) || 0;
  }

  /** Помечает сигнатуру как уже искавшуюся. */
  markErrorSearched(sig: string): void {
    this.searchedErrorSignatures.add(sig);
  }

  /** Снимает метку поиска (разрешает один ретрай). */
  unmarkErrorSearched(sig: string): void {
    this.searchedErrorSignatures.delete(sig);
  }

  /** True, если сигнатура уже искалась. */
  hasErrorSearched(sig: string): boolean {
    return this.searchedErrorSignatures.has(sig);
  }

  /** Сбрасывает наблюдения (полный reset детектора). */
  reset(): void {
    this.lastBashCommand = "";
    this.lastBashOutput = "";
    this.emptyBashRunCount = 0;
    this.bashRecent = [];
    this.errorSignatureCounts.clear();
    this.searchedErrorSignatures.clear();
  }
}
