// Имена записей провайдеров: display-имя и проверка коллизий.
// src/modules/providers/naming.ts
import type { ProviderEntry } from "../../config/types";

/** Display/identity-имя записи: label, иначе type. */
export function providerEntryName(entry: Pick<ProviderEntry, "label" | "type">): string {
  return entry.label || entry.type;
}

/**
 * Занято ли `name` другой записью (кроме `exceptName`).
 * Записи адресуются по `label || type`, легаси-поиск матчит и голый `type`,
 * так что новый/переименованный провайдер не должен коллизить ни с тем, ни с
 * другим — иначе `provider.active` и edit/delete молча бьют не в ту запись.
 * `exceptName` позволяет правке сохранить собственное текущее имя.
 */
export function providerNameTaken(
  entries: Array<Pick<ProviderEntry, "label" | "type">>,
  name: string,
  exceptName?: string,
): boolean {
  return entries.some(
    (e) =>
      providerEntryName(e) !== exceptName &&
      (providerEntryName(e) === name || e.type === name),
  );
}
