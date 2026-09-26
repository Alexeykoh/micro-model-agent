// src/modules/providers/naming.ts
import type { ProviderEntry } from "../../config/types";

/** Display/identity name of an entry: its label, or its type when unlabelled. */
export function providerEntryName(entry: Pick<ProviderEntry, "label" | "type">): string {
  return entry.label || entry.type;
}

/**
 * True when `name` is already used by an entry other than `exceptName`.
 *
 * Entries are addressed by `label || type`, and legacy lookups also match a
 * bare `type`. A new/renamed provider must therefore not collide with either —
 * otherwise `provider.active` and edit/delete could silently target the wrong
 * entry. `exceptName` lets an edit keep/reuse its own current name.
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
