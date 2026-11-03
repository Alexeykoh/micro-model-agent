/** Общий контекст шагов визарда: состояние, корневой gate и перерисовка. */
import type { SetupState } from "./setup-state.js";

export interface SetupContext {
  state: SetupState;
  gate: HTMLElement;
  render: () => void;
}
