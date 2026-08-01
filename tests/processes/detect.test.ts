import { describe, it, expect } from "vitest";
import { isLongRunningCommand } from "../../src/modules/processes";

describe("isLongRunningCommand", () => {
  it("detects dev servers", () => {
    expect(isLongRunningCommand("npm run dev")).toBe(true);
    expect(isLongRunningCommand("bun run dev --port 5173")).toBe(true);
    expect(isLongRunningCommand("yarn serve")).toBe(true);
    expect(isLongRunningCommand("pnpm start")).toBe(true);
    expect(isLongRunningCommand("npx vite")).toBe(true);
    expect(isLongRunningCommand("next dev")).toBe(true);
  });

  it("detects watchers and previews", () => {
    expect(isLongRunningCommand("tsc --watch")).toBe(true);
    expect(isLongRunningCommand("npm run test -- --watch")).toBe(true);
    expect(isLongRunningCommand("jest --watch")).toBe(true);
    expect(isLongRunningCommand("npm run preview")).toBe(true);
  });

  it("detects servers", () => {
    expect(isLongRunningCommand("uvicorn main:app")).toBe(true);
    expect(isLongRunningCommand("gunicorn wsgi:app")).toBe(true);
    expect(isLongRunningCommand("python -m http.server 8000")).toBe(true);
    expect(isLongRunningCommand("php artisan serve")).toBe(true);
  });

  it("does NOT flag one-shot commands", () => {
    expect(isLongRunningCommand("npm install")).toBe(false);
    expect(isLongRunningCommand("npm run build")).toBe(false);
    expect(isLongRunningCommand("vite build")).toBe(false);
    expect(isLongRunningCommand("bun test")).toBe(false);
    expect(isLongRunningCommand("git status")).toBe(false);
    expect(isLongRunningCommand("tsc --noEmit")).toBe(false);
  });
});
