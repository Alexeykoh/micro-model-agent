// Извлечение фактов для компакции: файлы/удаления/решения/ошибки/чтения переживают сжатие.
import type { Message } from "./manager";
import { getMessageText } from "../../llm/provider";

/**
 * Regex-извлечение фактов из tool/assistant-сообщений. Владеет списками фактов
 * файлов/удалений/решений/ошибок, переживающих компакцию. Вынесен из
 * ContextManager, чтобы ~115 строк regex-логики жили в одном месте (правило #2).
 */
export class FactExtractor {
  private fileFacts: string[] = [];
  private deletedFacts: string[] = [];
  private decisionFacts: string[] = [];
  private errorFacts: string[] = [];
  private readFacts: string[] = [];
  private static readonly MAX_FACTS = 20;

  /** Число накопленных фактов ошибок. */
  get errorCount(): number {
    return this.errorFacts.length;
  }

  /** Сканирует пачку уплотняемых ходов и вливает их факты в списки. */
  extract(turns: Message[]): void {
    // Абсолютные Windows-пути ("E:\proj\src\a.ts") требуют опционального префикса
    // диска; без него двоеточие ломает матч и факт молча теряется.
    const DRIVE = "(?:[a-zA-Z]:[\\\\/])?";
    const createdPatterns = [
      new RegExp(
        `(?:Created|Updated|Written|Moved|Replaced in) ${DRIVE}([\\w./\\\\-]+\\.[a-z]+)`,
        "gi",
      ),
      new RegExp(
        `Файл (?:создан|обновлён|записан|перемещён):? ${DRIVE}([\\w./\\\\-]+\\.[a-z]+)`,
        "gi",
      ),
      new RegExp(`file (?:created|updated|written|moved):? ${DRIVE}([\\w./\\\\-]+\\.[a-z]+)`, "gi"),
    ];
    const deletedPatterns = [
      new RegExp(`Deleted ${DRIVE}([\\w./\\\\-]+\\.[a-z]+)`, "gi"),
      new RegExp(`(?:Удалён|Файл удалён):? ${DRIVE}([\\w./\\\\-]+\\.[a-z]+)`, "gi"),
    ];
    // Заголовок вывода read_file — независящий от локали префикс `── path (ext, …`
    // (en: "lines", ru: "строк"). Путь в обеих локалях с тем же маркером,
    // поэтому паттерну локализация не нужна.
    const readPatterns = [new RegExp(`── (${DRIVE}[\\w./\\\\-]+\\.[a-z]+) \\(`, "gi")];

    const newFiles: string[] = [];
    const newDeleted: string[] = [];
    const newDecisions: string[] = [];
    const newErrors: string[] = [];
    const newReads: string[] = [];
    // Трекаем ПОСЛЕДНЕЕ событие тула на путь: удаление с пересозданием
    // (или наоборот) в том же окне резолвится в финальное состояние, а не
    // вылетает и из [Files:], и из [Deleted:].
    const lastEvent = new Map<string, "file" | "deleted">();

    for (const msg of turns) {
      const content = getMessageText(msg.content);

      // Системный промпт — никогда не источник фактов: модуль памяти встраивает
      // туда errors.md с историческими "Tool X failed Nx" ПРОШЛЫХ дней, и их
      // извлечение как текущих [Errors:] вводит модель в заблуждение, будто
      // фейлит ОНА (было: ses_msvuao0h — протухшее "edit_file failed 3x"
      // от 2026-08-15 попадало в каждую сводку как живой фейл сессии).
      if (msg.role === "system") continue;

      // Прошлый <system-summary> — никогда не источник новых фактов, иначе
      // рекурсивная вложенность сводок (сводка внутри сводки).
      if (
        msg.role === "user" &&
        (content.startsWith("<system-summary>") || content.includes("[Compressed:"))
      ) {
        continue;
      }

      if (msg.role === "tool") {
        for (const pattern of createdPatterns) {
          for (const match of content.matchAll(pattern)) {
            newFiles.push(match[1]);
            lastEvent.set(match[1], "file");
          }
        }
        for (const pattern of deletedPatterns) {
          for (const match of content.matchAll(pattern)) {
            newDeleted.push(match[1]);
            lastEvent.set(match[1], "deleted");
          }
        }
        for (const pattern of readPatterns) {
          for (const match of content.matchAll(pattern)) {
            newReads.push(match[1]);
          }
        }

        if (content.includes("Plan:") && content.includes("[")) {
          const planLine = content.split("\n").find((line) => line.includes("Plan:"));
          if (planLine) newDecisions.push(planLine.trim());
        }
      }

      if (msg.role === "assistant") {
        if (content.includes("decided:") || content.includes("decision:")) {
          const line = content
            .split("\n")
            .find((l) => l.includes("decided:") || l.includes("decision:"));
          if (line) newDecisions.push(line.trim().slice(0, 200));
        }
      }

      if (msg.role === "tool" || msg.role === "assistant") {
        if (
          content.includes("Error:") ||
          content.includes("failed") ||
          content.includes("Ошибка:") ||
          content.includes("не удалось")
        ) {
          // Строка "3 passed, 0 failed" — УСПЕШНЫЙ прогон тестов, не ошибка:
          // считать её деградирует качество контекста без причины.
          const ZERO_FAILURES =
            /\b0\s+(?:failed|failing|failures?)\b|(?:failed?|failures?|ошиб[а-я]*)\s*[:=]\s*0\b/i;
          const candidates = content
            .split("\n")
            .filter(
              (l) =>
                l.includes("Error:") ||
                l.includes("failed") ||
                l.includes("Ошибка:") ||
                l.includes("не удалось"),
            );
          const line = candidates.find((l) => !ZERO_FAILURES.test(l));
          if (line) newErrors.push(line.trim().slice(0, 250));
        }
      }
    }

    // Дедуп и кап фактов против unbounded-роста. УДАЛЁННЫЕ файлы уходят из
    // "известных": удалённый файл не должен числиться существующим (было:
    // удалённые .js висели в каждом [Files: ...] всю сессию). Путь, удалённый
    // и ПЕРЕСОЗДАННЫЙ (delete_file A → write_file A), возвращается в [Files:]
    // и уходит из [Deleted:] — побеждает последнее событие окна.
    const dedup = (arr: string[]): string[] => [...new Set(arr)];
    const finalFiles = dedup(newFiles.filter((p) => lastEvent.get(p) === "file"));
    const finalDeleted = dedup(newDeleted.filter((p) => lastEvent.get(p) === "deleted"));
    this.fileFacts = dedup(
      [...this.fileFacts, ...finalFiles].filter((p) => !finalDeleted.includes(p)),
    ).slice(-FactExtractor.MAX_FACTS);
    this.deletedFacts = dedup(
      [...this.deletedFacts, ...finalDeleted].filter((p) => !finalFiles.includes(p)),
    ).slice(-FactExtractor.MAX_FACTS);
    this.decisionFacts = dedup([...this.decisionFacts, ...newDecisions]).slice(
      -FactExtractor.MAX_FACTS,
    );
    this.errorFacts = dedup([...this.errorFacts, ...newErrors]).slice(-FactExtractor.MAX_FACTS);
    this.readFacts = dedup([...this.readFacts, ...newReads]).slice(-FactExtractor.MAX_FACTS);
  }

  /** Строка `[Files: a; b]` для сводки компакции, или null. */
  filesLine(): string | null {
    const deletedSet = new Set(this.deletedFacts);
    const liveFiles = this.fileFacts.filter((p) => !deletedSet.has(p));
    if (liveFiles.length === 0) return null;
    return `[Files: ${liveFiles.slice(-15).join("; ")}]`;
  }

  /** Все известные живые файлы (не удалённые) — сидируют known-files проверки
   *  галлюцинаций после компакции. */
  getKnownFiles(): string[] {
    const deletedSet = new Set(this.deletedFacts);
    return this.fileFacts.filter((p) => !deletedSet.has(p));
  }

  /** Строка `[Deleted: c]`, или null. */
  deletedLine(): string | null {
    if (this.deletedFacts.length === 0) return null;
    return `[Deleted: ${this.deletedFacts.slice(-10).join("; ")}]`;
  }

  /** Строка `[Decisions: d]`, или null. */
  decisionsLine(): string | null {
    if (this.decisionFacts.length === 0) return null;
    return `[Decisions: ${this.decisionFacts.slice(-5).join("; ")}]`;
  }
  /** Строка `[Errors: e]`, или null. */
  errorsLine(): string | null {
    if (this.errorFacts.length === 0) return null;
    return `[Errors: ${this.errorFacts.slice(-3).join("; ")}]`;
  }
  /**
   * Строка `[Read: p1; p2]` — файлы, уже просмотренные через read_file. После
   * компакции модель переориентируется без рескана проекта: знает, что уже
   * читала, и перечитывает только изменившееся (было: после компакции модель
   * перечитывала те же файлы, т.к. "уже прочитано" компакцию не переживало).
   */
  readLine(): string | null {
    if (this.readFacts.length === 0) return null;
    return `[Read: ${this.readFacts.slice(-12).join("; ")}]`;
  }
}
