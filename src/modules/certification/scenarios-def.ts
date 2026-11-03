// Сценарий до подмешивания базового конфига провайдера (общий тип групп).
import type { CertScenario } from "./types";

export type ScenarioDef = Omit<CertScenario, "config"> & { config?: Record<string, unknown> };
