/**
 * Живая пересборка статичного system-блока (B14/B18b/L5).
 *
 * Вынесено из `system-prompt.ts` (правило ≤300 строк). Bootstrap фиксирует
 * systemInfo один раз; факты (команды проекта, autoPlan, security, LSP,
 * часовой пояс, языки, large-экстры) собираются заново из живых зависимостей
 * и блок меняется на месте: порядок и приоритет сохраняются, prefix-cache
 * рвётся один раз.
 */
import type { AgentDeps } from "./agent/deps";
import { estimateTokens } from "../llm/token-counter";
import {
  collectPromptFacts,
  fallbackPromptFacts,
  type ClientTz,
} from "./prompt-facts";
import { buildSystemInfo, resolvePromptProfile } from "./system-prompt";

/** Топ языков проекта из индексатора для large-профиля (B6: поле больше не мёртвое). */
function topLanguages(deps: AgentDeps): string[] {
  try {
    const indexer = deps.moduleRegistry?.get("indexer") as
      | { mapInfo?: () => { languages?: Array<{ language: string }> } }
      | undefined;
    return (indexer?.mapInfo?.().languages ?? []).map((l) => l.language).slice(0, 3);
  } catch {
    return [];
  }
}

/**
 * Пересборка статичного system-блока из живых зависимостей.
 * Профиль (`full`/`large`) резолвится из живого конфига — смена окна или
 * ручной override подхватываются следующим reconfigure (L5).
 * @param deps живые зависимости агента.
 * @returns true — блок найден и пересобран; false — нечего обновлять.
 */
export function refreshSystemInfoBlock(deps: AgentDeps): boolean {
  if (!deps.profileCompressed) return false;
  const idx = deps.promptBlocks.findIndex((b) => b.source === "core" && b.label === "system");
  if (idx < 0) return false;
  const facts = deps.envReport
    ? collectPromptFacts({
        config: deps.config,
        baseDir: deps.baseDir,
        envReport: deps.envReport,
        activeToolTags: deps.toolTags,
        clientTz: deps.clientTz,
        languages: topLanguages(deps),
      })
    : fallbackPromptFacts(deps.config, deps.baseDir, deps.profileCompressed, deps.clientTz);
  const content = buildSystemInfo(
    deps.config,
    deps.baseDir,
    deps.profileCompressed,
    facts,
    resolvePromptProfile(deps.config.promptProfile, deps.config),
  );
  deps.promptBlocks[idx] = {
    ...deps.promptBlocks[idx]!,
    content,
    estimatedTokens: estimateTokens(content),
  };
  return true;
}

/**
 * Применяет часовой пояс клиента к агенту (B18b): запоминает и пересобирает
 * статику, если пояс сменился. No-op при том же значении (пересборка рвёт
 * prefix-cache — не дёргаем её на каждом ходу).
 * @returns true — статика пересобрана; false — нечего обновлять.
 */
export function applyClientTz(deps: AgentDeps, tz: ClientTz | undefined): boolean {
  const cur = deps.clientTz;
  if (!tz) {
    if (!cur) return false;
    deps.clientTz = undefined;
    return refreshSystemInfoBlock(deps);
  }
  if (cur && cur.timeZone === tz.timeZone && cur.utcOffset === tz.utcOffset) return false;
  deps.clientTz = tz;
  return refreshSystemInfoBlock(deps);
}
