// Syntax checks for the verifier (spec 2026-11-03-language-adapters-design).
// Extracted from `verifier.ts` (rule 6): TS/JS keep their own compilers, every
// other language goes through `adapterForExt`, and a missing binary degrades
// fail-open instead of blocking the step.
import { readFileSync } from "fs";
import { extname, dirname } from "path";
import { resolveTscCommand } from "../lsp/project-root";
import { adapterForExt } from "./language-adapters";

export interface SyntaxDeps {
  baseDir: string;
  run: (command: string, cwd: string, timeoutMs: number) => Promise<unknown>;
  degrade: (operation: string, reason: string) => void;
}

/** True = syntax ok (or check unavailable), false = syntax error. */
export async function checkSyntax(filePath: string, deps: SyntaxDeps): Promise<boolean> {
  const ext = extname(filePath).toLowerCase();

  const adapter = adapterForExt(ext);
  if (adapter?.kind === "json") {
    try {
      JSON.parse(readFileSync(filePath, "utf-8"));
      return true;
    } catch {
      return false;
    }
  }
  if (adapter?.kind === "command") {
    try {
      await deps.run(adapter.command(filePath), deps.baseDir, adapter.timeoutMs);
      return true;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (err?.status === 127 || /not found|ENOENT|not recognized/i.test(msg)) {
        deps.degrade(
          "verify.syntax",
          `syntax check could not run for ${filePath}: ${msg.slice(0, 200)}`,
        );
        return true;
      }
      return false;
    }
  }

  if (ext === ".ts" || ext === ".tsx" || ext === ".cts" || ext === ".mts") {
    const tsc = resolveTscCommand(dirname(filePath));
    if (!tsc) {
      deps.degrade(
        "verify.syntax",
        `typescript compiler not found; syntax not checked for ${filePath}`,
      );
      return true;
    }
    try {
      await deps.run(`${tsc} --noEmit --skipLibCheck "${filePath}"`, deps.baseDir, 20_000);
      return true;
    } catch (err: any) {
      if (
        err.status === 127 ||
        err.message.includes("not found") ||
        err.message.includes("ENOENT")
      ) {
        deps.degrade(
          "verify.syntax",
          `syntax check could not run for ${filePath}: ${String(err.message).slice(0, 200)}`,
        );
        return true;
      }
      const stderr = err.stderr?.toString() || "";
      if (stderr.includes("error TS") && !stderr.includes("Cannot find module")) return false;
      deps.degrade(
        "verify.syntax",
        `syntax check inconclusive for ${filePath}: ${stderr.slice(0, 200) || err.message}`,
      );
      return true;
    }
  }

  if (ext === ".js" || ext === ".jsx" || ext === ".cjs" || ext === ".mjs") {
    try {
      await deps.run(`node --check "${filePath}"`, deps.baseDir, 5000);
      return true;
    } catch {
      return false;
    }
  }

  return true;
}
