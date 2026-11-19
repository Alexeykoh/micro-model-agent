// Хост черновиков: связывает файлы в `drafts/` с реестром плагинов.
//
// Разделение намеренное: `drafts.ts` — чистая работа с диском и текстом согласия
// (легко тестируется), здесь — единственное место, где черновик превращается в
// зарегистрированный плагин. Ошибки загрузки не поднимаются вверх: битый черновик
// обязан остаться битым в UI (`getFailures`), а не уронить ход агента.
import { join } from "path";
import type { PluginManager, ReloadReport } from "./manager";
import { PluginLoader } from "./loader";
import {
  consentText,
  draftsDir,
  isApproved,
  listDrafts,
  removeDraft,
  setApproved,
  writeDraft,
  type DraftHost,
  type DraftSpec,
  type DraftsState,
  type DraftWriteResult,
  type PluginDraft,
} from "./drafts";
import type { AppConfig } from "../../config/types";
import { DEFAULT_MAX_DRAFTS } from "./drafts";

export interface DraftHostDeps {
  baseDir: string;
  pluginManager: PluginManager;
  /** Версия MMA для гейта `minMmaVersion` при загрузке черновика. */
  mmaVersion?: string;
  /** Живой конфиг — за лимит черновиков (`plugins.maxDrafts`). */
  configRef?: { current: AppConfig };
  logger?: { warn: (msg: string) => void };
}

/** Каталог черновиков как «проектный» источник плагинов. */
function asProjectDir(baseDir: string): string {
  return draftsDir(baseDir);
}

/** Лимит черновиков из конфига, с откатом на дефолт. */
function maxDrafts(configRef?: { current: AppConfig }): number {
  const value = configRef?.current.plugins?.maxDrafts;
  return typeof value === "number" && value > 0 ? value : DEFAULT_MAX_DRAFTS;
}

/** Хост + стартовая загрузка одобренных черновиков (нужна bootstrap'у). */
export type DraftHostWithLoad = DraftHost & { loadApproved(): ReloadReport | null };

/**
 * Создать хост черновиков. Загрузка разрешённых черновиков — отдельный вызов
 * (`loadApproved`) на старте: молчаливый side-effect в конструкторе сделал бы
 * порядок загрузки неявным.
 */
export function createDraftHost(deps: DraftHostDeps): DraftHostWithLoad {
  const { baseDir, pluginManager, logger } = deps;
  const loader = new PluginLoader();

  const reloadDrafts = (): ReloadReport =>
    loader.reloadFromDir(asProjectDir(baseDir), pluginManager, logger, {
      source: "project",
      ...(deps.mmaVersion ? { mmaVersion: deps.mmaVersion } : {}),
    });

  return {
    baseDir,
    state(): DraftsState {
      return {
        approved: isApproved(baseDir),
        drafts: listDrafts(baseDir),
        loaded: pluginManager
          .getRecords()
          .filter((r) => r.draft && r.enabled)
          .map((r) => r.name),
      };
    },
    approve(): void {
      setApproved(baseDir, true);
    },
    revoke(): void {
      // Сначала выгружаем код, потом снимаем разрешение: иначе между этими
      // двумя шагами загруженный черновик остался бы активным без согласия.
      pluginManager.unloadByDir(asProjectDir(baseDir));
      setApproved(baseDir, false);
    },
    write(spec: DraftSpec, options): DraftWriteResult {
      return writeDraft(baseDir, spec, { maxDrafts: maxDrafts(deps.configRef), ...options });
    },
    remove(name: string): boolean {
      const removed = removeDraft(baseDir, name);
      if (removed) pluginManager.unloadByDir(asProjectDir(baseDir));
      return removed;
    },
    consentPreview(): string {
      const drafts = listDrafts(baseDir);
      return drafts.length > 0 ? consentText(drafts) : "";
    },
    loadApproved(): ReloadReport | null {
      if (!isApproved(baseDir)) return null;
      return reloadDrafts();
    },
    reloadDrafts,
    lastError(name: string): string | null {
      const dir = asProjectDir(baseDir);
      const wanted = [join(dir, `${name}.ts`), join(dir, `${name}.js`)];
      const hit = pluginManager.getFailures().find((f) => wanted.includes(f.path));
      return hit ? hit.message : null;
    },
  };
}

/** Черновики, ждущие решения (для предупреждения при старте и в UI). */
export function pendingDrafts(baseDir: string): PluginDraft[] {
  return listDrafts(baseDir);
}