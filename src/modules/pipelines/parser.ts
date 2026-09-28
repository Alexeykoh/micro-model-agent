// Минималистичный парсер YAML-описаний пайплайнов (без внешних зависимостей).
import { t } from "../../i18n/index";

/** Один шаг пайплайна: агент, промпт, зависимости и повторы. */
export interface PipelineStep {
  id: string;
  agent: string;
  prompt: string;
  depends_on?: string[];
  parallel?: boolean;
  max_retries?: number;
}

/** Пайплайн: имя и упорядоченный список шагов. */
export interface Pipeline {
  name: string;
  steps: PipelineStep[];
}

/** Парсер описания пайплайна. Бросает при невалидном YAML/полях. */
export class PipelineParser {
  /** Разбирает YAML в `Pipeline`; бросает с локализованной ошибкой. */
  static parse(yaml: string): Pipeline {
    const lines = yaml.split("\n").filter((l) => l.trim());
    const result: any = {};
    let currentSection: string | null = null;
    const currentSteps: any[] = [];

    for (const line of lines) {
      if (line.match(/^\w+:/) && !line.startsWith(" ") && !line.startsWith("  -")) {
        const [key, ...valParts] = line.split(":");
        const val = valParts.join(":").trim();
        if (key === "steps") {
          currentSection = "steps";
        } else {
          result[key] = val;
          currentSection = null;
        }
      } else if (currentSection === "steps") {
        const stepMatch = line.match(/^\s+- id:\s*(\S+)/);
        if (stepMatch) {
          currentSteps.push({ id: stepMatch[1] });
        } else if (currentSteps.length > 0) {
          const lastStep = currentSteps[currentSteps.length - 1];
          const kvMatch = line.match(/^\s+(\w+):\s*(.+)$/);
          if (kvMatch) {
            const key = kvMatch[1];
            let val: any = kvMatch[2].trim();
            if (val === "true") val = true;
            else if (val === "false") val = false;
            else if (val.startsWith("[") && val.endsWith("]")) {
              val = val
                .slice(1, -1)
                .split(",")
                .map((s: string) => s.trim().replace(/^['"]|['"]$/g, ""));
            }
            lastStep[key] = val;
          }
        }
      }
    }

    if (!result.name || currentSteps.length === 0) {
      throw new Error(t("pipeline.invalid"));
    }

    for (const step of currentSteps) {
      if (!step.id || !step.agent || !step.prompt) {
        throw new Error(t("pipeline.step_missing_fields", { step: JSON.stringify(step) }));
      }
    }

    return { name: result.name, steps: currentSteps };
  }
}
