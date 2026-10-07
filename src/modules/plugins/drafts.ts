// Черновики capabilities: код, написанный агентом через `define_capability`.
//
// Ключевое решение — **инертность по умолчанию**: файл в `drafts/` не грузится,
// пока пользователь явно не разрешит. Плагин из черновика — это чужой код, который
// выполнится в процессе агента, поэтому «покажу при первом запуске и спрошу» было
// худшей версией: в headless-режиме вопрос некому задать, а молча грузить нельзя.
//
// Маркер разрешения лежит РЯДО с каталогом (`.mma/plugins/.drafts-approved`), а не
// внутри: иначе скан плагинов подхватил бы его как плагин. Он проектный, а не
// глобальный — согласие на код одного воркспейса не должно молча разрешать код
// во всех остальных.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { t } from "../../i18n/index";
import type { ReloadReport } from "./manager";

/** Каталог черновиков внутри проекта: `<baseDir>/.mma/plugins/drafts`. */
export function draftsDir(baseDir: string): string {
  return join(baseDir, ".mma", "plugins", "drafts");
}

/** Файл-маркер разрешения (вне каталога черновиков). */
export function approvalMarker(baseDir: string): string {
  return join(baseDir, ".mma", "plugins", ".drafts-approved");
}

/** Один черновик на диске. */
export interface PluginDraft {
  /** Имя файла без расширения = имя capability. */
  name: string;
  path: string;
  code: string;
  /** Время последней записи — для вытеснения по LRU. */
  mtimeMs: number;
}

/** Что агент описал новой capability (сырые аргументы тула). */
export interface DraftSpec {
  name: string;
  description: string;
  /** JSON-схема аргументов тула (объект). */
  parameters: Record<string, unknown>;
  /** Тело хендлера: уходит внутрь `async (ctx, args) => { … }`. */
  code: string;
  /** Права, которые capability запрашивает. Для черновика — обязательны. */
  permissions: string[];
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_DESCRIPTION = 400;
const MAX_CODE = 20_000;
/** Сколько черновиков держим на проект; лишние вытесняются по LRU. */
export const DEFAULT_MAX_DRAFTS = 10;

/** Разрешено ли выполнять черновики этого проекта. */
export function isApproved(baseDir: string): boolean {
  return existsSync(approvalMarker(baseDir));
}

/** Записать/снять разрешение. `revoke` удаляет маркер — черновики снова инертны. */
export function setApproved(baseDir: string, on: boolean): void {
  const marker = approvalMarker(baseDir);
  if (on) {
    mkdirSync(join(baseDir, ".mma", "plugins"), { recursive: true });
    writeFileSync(marker, new Date().toISOString(), "utf-8");
    return;
  }
  if (existsSync(marker)) unlinkSync(marker);
}

/** Прочитать черновики (без каталога — пусто). Только `.ts`/`.js`, без вложенных. */
export function listDrafts(baseDir: string): PluginDraft[] {
  const dir = draftsDir(baseDir);
  if (!existsSync(dir)) return [];
  const drafts: PluginDraft[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".ts") && !entry.endsWith(".js")) continue;
    const path = join(dir, entry);
    try {
      drafts.push({
        name: entry.replace(/\.(ts|js)$/, ""),
        path,
        code: readFileSync(path, "utf-8"),
        mtimeMs: statSync(path).mtimeMs,
      });
    } catch {
      // Нечитаемый черновик — не повод ронять список.
    }
  }
  return drafts;
}

/** Проверка описания capability. Возвращает текст проблемы или null. */
export function validateDraftSpec(spec: DraftSpec): string | null {
  if (!spec.name || !NAME_RE.test(spec.name)) return `name must match ${NAME_RE.source}`;
  if (!spec.description?.trim()) return "description is required";
  if (spec.description.length > MAX_DESCRIPTION) {
    return `description is longer than ${MAX_DESCRIPTION} chars`;
  }
  if (!spec.parameters || typeof spec.parameters !== "object") {
    return "parameters must be a JSON object schema";
  }
  if (!spec.code?.trim()) return "code is required";
  if (spec.code.length > MAX_CODE) return `code is longer than ${MAX_CODE} chars`;
  // Права обязательны: показываемое декларативное поле без единого заявления
  // ничего не значит (иначе «права» превращаются в пустую формальность).
  if (!Array.isArray(spec.permissions) || spec.permissions.length === 0) {
    return "permissions are required for a draft capability";
  }
  return null;
}

/**
 * Собрать исходник плагина из описания capability.
 *
 * Никакого `eval`: тело хендлера пишется в файл как есть, а выполняется обычным
 * путём загрузки плагинов (`PluginLoader.require`).
 */
export function renderDraft(spec: DraftSpec): string {
  const perms = JSON.stringify(spec.permissions);
  return `// Черновик capability "${spec.name}", создан агентом через define_capability.
// Файл НЕ выполняется, пока пользователь не разрешит черновики этого проекта
// (mma plugins drafts approve). Код ниже написан агентом и исполняется в процессе агента.
const handler = async (ctx, args) => {
${spec.code}
};

export default {
  name: ${JSON.stringify(spec.name)},
  version: "0.0.1",
  description: ${JSON.stringify(spec.description)},
  permissions: ${perms},
  getToolDefinitions: () => [
    {
      name: ${JSON.stringify(spec.name)},
      description: ${JSON.stringify(spec.description)},
      parameters: ${JSON.stringify(spec.parameters, null, 2)},
      handler,
    },
  ],
};
`;
}

/** Итог записи черновика. */
export interface DraftWriteResult {
  ok: boolean;
  /** Текст проблемы (при `ok: false`) — показывается и модели, и пользователю. */
  error?: string;
  path?: string;
  /** Имена вытесненных по LRU черновиков (файлы удалены). */
  evicted: string[];
  /** Лежит ли теперь этот capability (всегда true при ok). */
  written: boolean;
}

/**
 * Записать черновик: шаблон на диск + вытеснение лишнего по LRU.
 * Пишет, но **не грузит** — загрузка только после согласия пользователя.
 */
export function writeDraft(
  baseDir: string,
  spec: DraftSpec,
  options?: { maxDrafts?: number },
): DraftWriteResult {
  const problem = validateDraftSpec(spec);
  if (problem) return { ok: false, error: problem, evicted: [], written: false };

  const dir = draftsDir(baseDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${spec.name}.ts`);
  writeFileSync(path, renderDraft(spec), "utf-8");

  const max = options?.maxDrafts ?? DEFAULT_MAX_DRAFTS;
  const evicted = enforceLimit(baseDir, max);
  return { ok: true, path, evicted, written: true };
}

/** Оставить не больше `max` черновиков; лишние удаляются по LRU (старые первыми). */
export function enforceLimit(baseDir: string, max: number): string[] {
  const drafts = listDrafts(baseDir);
  if (drafts.length <= max) return [];
  const doomed = drafts
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(0, drafts.length - max);
  for (const draft of doomed) {
    try {
      unlinkSync(draft.path);
    } catch {
      // Файл уже исчез — вытеснение состоялось.
    }
  }
  return doomed.map((d) => d.name);
}

/** Удалить черновик по имени (истина, если файл был). */
export function removeDraft(baseDir: string, name: string): boolean {
  if (!NAME_RE.test(name)) return false;
  for (const ext of [".ts", ".js"]) {
    const path = join(draftsDir(baseDir), `${name}${ext}`);
    if (existsSync(path)) {
      unlinkSync(path);
      return true;
    }
  }
  return false;
}

/**
 * Текст согласия: имена файлов и **полный код** (иначе согласие вслепую).
 * Обрезаем только безнадёжно огромный файл, помечая это явно.
 */
export function consentText(drafts: PluginDraft[]): string {
  const lines = [t("plugin.draft_consent_head", { count: String(drafts.length) })];
  for (const draft of drafts) {
    const truncated = draft.code.length > 8000;
    lines.push("", `--- ${draft.name} ---`);
    lines.push(truncated ? `${draft.code.slice(0, 8000)}\n… (+${draft.code.length - 8000} символов)` : draft.code);
  }
  lines.push("", t("plugin.draft_consent_foot"));
  return lines.join("\n");
}

/** Опции согласия (для хоста: сессия/вопрос). */
export interface ConsentChoice {
  approved: boolean;
}

/** Плоский итог загрузки черновиков для CLI/UI. */
export interface DraftsState {
  approved: boolean;
  drafts: PluginDraft[];
  /** Загруженные сейчас capability (из записей плагинов с `draft: true`). */
  loaded: string[];
}

/** Поведение загрузчика, необходимое хосту черновиков. */
export interface DraftLoader {
  /** Перечитать каталог черновиков (сброс кэша модулей) — отдаёт отчёт reload. */
  reloadDrafts(): ReloadReport;
}

/**
 * Хост черновиков: то, что доступно тулу `define_capability` через контекст.
 * Узкий интерфейс — контекст тулов не должен знать про загрузчик плагинов.
 */
export interface DraftHost {
  baseDir: string;
  state(): DraftsState;
  approve(): void;
  revoke(): void;
  write(
    spec: DraftSpec,
    options?: { maxDrafts?: number },
  ): DraftWriteResult;
  remove(name: string): boolean;
  /** Текст согласия по текущим черновикам (пустой, если черновиков нет). */
  consentPreview(): string;
  /**
   * Перечитать каталог черновиков (сброс кэша модулей) — отчёт reload.
   * Живёт в интерфейсе, а не в реализации: `define_capability` после согласия
   * обязан подхватить только что записанный файл без рестарта процесса.
   */
  reloadDrafts(): ReloadReport;
}
