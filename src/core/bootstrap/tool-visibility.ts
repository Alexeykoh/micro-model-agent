import type { AppConfig } from "../../config/types";
import { isExplicitLargeProfile } from "../system-prompt";

export interface ToolVisibility {
  enableOnDemand: boolean;
  activeToolTags: string[];
}

/** Видимость тулов: широкий набор только при явном large или enableOnDemand:false. */
export function resolveToolVisibility(config: AppConfig): ToolVisibility {
  const explicitLarge = isExplicitLargeProfile(config);
  const enableOnDemand = config.tools?.enableOnDemand !== false && !explicitLarge;
  return {
    enableOnDemand,
    activeToolTags: enableOnDemand ? [...(config.tools?.defaultTags ?? [])] : [],
  };
}
