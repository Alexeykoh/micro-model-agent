// Типы сертификации моделей: сценарии, проверки, результаты и манифест.
export type CertTag = "core" | "security" | "image" | "network" | "browser" | "shell" | "research";

/** Одна проверка песочницы после прогона сценария. */
export type CertCheck =
  | { type: "fileExists"; path: string }
  | { type: "fileNotExists"; path: string }
  | { type: "dirExists"; path: string }
  | { type: "fileContent"; path: string; contains?: string; equals?: string }
  | { type: "fileRegex"; path: string; pattern: string }
  | { type: "exitCode"; code?: number }
  | { type: "outputContains"; text: string };

/** Файл-фиixture: копируется в песочницу перед прогоном. */
export interface CertFixture {
  source: string;
  dest: string;
}

/** Сценарий сертификации: промпт модели плюс проверки результата. */
export interface CertScenario {
  id: string;
  title: string;
  tags: CertTag[];
  mode: "run" | "skip";
  prompt: string;
  reps?: number;
  passThreshold?: number;
  /** Таймаут одного повтора в мс. Медленным многошаговым сценариям на локальных reasoning-моделях нужно больше дефолтных 300с. */
  timeoutMs?: number;
  fixtures?: CertFixture[];
  checks: CertCheck[];
  skipReason?: string;
  /** Переопределения конфига для сценария. Сливаются с базовым и пишутся в песочницу. */
  config?: Record<string, unknown>;
}

/** Статус сценария после прогона. */
export type ScenarioStatus = "pass" | "fail" | "error" | "skipped";

/** Итог сценария: сколько повторов прошли и диагностика при провале. */
export interface ScenarioResult {
  id: string;
  title: string;
  status: ScenarioStatus;
  passed: number;
  of: number;
  error?: string;
  /** Диагностика из песочницы: созданные файлы, состояние плана. Только при провале. */
  diagnostics?: string;
}

/** Сводка прогона всего набора сценариев. */
export interface SuiteSummary {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

/** Запись о сертификации одной пары (модель, провайдер). */
export interface CertificationEntry {
  model: string;
  providerUrl: string;
  mmaVersion: string;
  certifiedAt: string;
  suite: SuiteSummary;
  results: ScenarioResult[];
}

/** Манифест со всеми записями о сертификации. */
export interface CertManifest {
  version: 1;
  certifications: CertificationEntry[];
}

/** Метка свежести сертификации модели. */
export type CertMark = "certified" | "stale" | "none";
