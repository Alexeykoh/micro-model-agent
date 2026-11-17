// Which capabilities to show for the active model in the composer chip.
// Kept as a pure function so the mapping is testable without a DOM and the
// selector renderer stays a thin painter.

export type CapabilityKey = "vision" | "video" | "audio" | "pdf" | "tools" | "reasoning";

export interface ModelCapabilitiesView {
  vision?: boolean;
  video?: boolean;
  audio?: boolean;
  pdf?: boolean;
  tools?: boolean;
}

/** `reasoning.strategy` from `GET /api/models` (only the fields we read). */
export interface ReasoningViewLike {
  strategy?: string;
  reachable?: boolean;
}

/**
 * Positive abilities only: media/tools from the resolved server view, reasoning
 * when the endpoint declared a real strategy. Unknown capabilities → `[]`
 * (the chip is hidden, never a wrong `text-only`).
 */
export function capabilityKeys(
  caps: ModelCapabilitiesView | null | undefined,
  reasoning: ReasoningViewLike | null | undefined,
): CapabilityKey[] {
  if (!caps) return [];
  const keys: CapabilityKey[] = [];
  for (const key of ["vision", "video", "audio", "pdf", "tools"] as const) {
    if (caps[key] === true) keys.push(key);
  }
  if (reasoning?.strategy && reasoning.strategy !== "none") keys.push("reasoning");
  return keys;
}
