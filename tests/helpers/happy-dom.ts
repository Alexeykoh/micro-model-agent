// Shared happy-dom bootstrap for frontend DOM tests. `bun test` does not apply
// vitest's environment docblock, so the globals are wired manually; this keeps
// the assignment list in one place instead of copied per test file.
import { Window } from "happy-dom";

const DOM_GLOBALS = [
  "window",
  "document",
  "location",
  "localStorage",
  "HTMLElement",
  "Node",
  "Event",
  "KeyboardEvent",
  "navigator",
] as const;

/** Points the app globals at a fresh happy-dom Window; returns it for tests. */
export function setupHappyDom(html = ""): Window {
  const win = new Window({ url: "http://localhost/" });
  const g = globalThis as unknown as Record<string, unknown>;
  const w = win as unknown as Record<string, unknown>;
  for (const key of DOM_GLOBALS) g[key] = w[key];
  if (html) win.document.body.innerHTML = html;
  return win;
}
