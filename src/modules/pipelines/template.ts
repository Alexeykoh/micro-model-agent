// Подстановка в шаблоны: `{param}` из params и `{{steps.<id>.output}}` из выходов шагов.
export class TemplateEngine {
  /**
   * Рендерит шаблон. Неизвестный выход шага остаётся плейсхолдером как есть.
   */
  static render(
    template: string,
    params: Record<string, string>,
    stepOutputs?: Record<string, { output: string }>,
  ): string {
    let result = template;

    for (const [key, val] of Object.entries(params)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, "g"), val);
    }

    if (stepOutputs) {
      result = result.replace(/\{\{steps\.(\w+)\.output\}\}/g, (_, stepId) => {
        return stepOutputs[stepId]?.output || `{{steps.${stepId}.output}}`;
      });
    }

    return result;
  }
}
