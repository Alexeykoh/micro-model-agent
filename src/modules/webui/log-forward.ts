// Мост `OutputBus` → SSE для `mma web`: варнинги/ошибки шины в браузер.
/**
 * Агент/bootstrap пишут человекочитаемые варнинги и ошибки в процессную
 * глобальную шину {@link defaultOutputBus} (переполнение системного промпта,
 * context probe, суммаризация). В терминале они рендерятся над промптом; в
 * вебе их никто не форвардил, и медленная суммаризация первого запуска
 * выглядела молчаливым висом. Подписывается на шину и переиздаёт интересные
 * уровни SSE-событиями `log`. `debug` дропается (терминальный шум); диагностики
 * петли идут с `diagnostic: true` и рендерятся клиентом только в verbose.
 *
 * Секреты вычищаются той же точечной редактурой, что везде в веб-транспорте;
 * браузер рендерит `text` через `textContent`.
 */
import type { OutputBus } from "../../output/bus";
import { defaultOutputBus } from "../../output/bus";
import type { OutputEvent, OutputLevel } from "../../output/types";
import { redactContextSecrets } from "../../core/agent/context-log";
import { broadcast, type WebUiState } from "./state";

const FORWARDED: readonly OutputLevel[] = ["info", "warn", "error"];

/** Подписывает `state` на `bus`; возвращает отписку (звать в `stop()`). */
export function installOutputForwarding(
  state: WebUiState,
  bus: OutputBus = defaultOutputBus,
): () => void {
  return bus.subscribe((ev: OutputEvent) => {
    if (!FORWARDED.includes(ev.level)) return;
    broadcast(
      {
        type: "log",
        ts: ev.ts,
        level: ev.level,
        source: ev.source,
        text: redactContextSecrets(ev.text),
        // Диагностики петли видны в чате только в verbose (гейт на клиенте).
        diagnostic: ev.data?.diagnostic === true,
      },
      state,
    );
  });
}
