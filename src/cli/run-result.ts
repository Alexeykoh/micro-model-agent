import { t } from "../i18n/index";
import { pc } from "../ui/colors";

/**
 * Render a single-run AgentResult to the terminal (non-JSON mode) and return
 * the process exit code.
 *
 * On failure only the error is printed. The model's `text` (which is the last
 * *accepted* message, i.e. possibly stale after an audit/hallucination error)
 * was already streamed live during the run — re-printing it here misleadingly
 * suggests the task succeeded.
 */
export function printRunResult(
  result: { success: boolean; text?: string; error?: string },
  flush: () => void,
): number {
  flush();
  if (result.success) {
    if (!result.text) {
      console.log(pc.yellow(t("cli.no_output")));
    }
    return 0;
  }
  console.error(`${t("error.prefix")}${result.error}`);
  return 1;
}
