import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { CertCheck } from "./types";

export interface CheckOutcome {
  pass: boolean;
  failures: string[];
}

export function checkSandbox(
  sandboxDir: string,
  checks: CertCheck[],
  exitCode: number,
  output: string,
): CheckOutcome {
  const failures: string[] = [];
  for (const check of checks) {
    if (!runCheck(sandboxDir, check, exitCode, output)) {
      failures.push(describe(check));
    }
  }
  return { pass: failures.length === 0, failures };
}

function runCheck(
  sandboxDir: string,
  check: CertCheck,
  exitCode: number,
  output: string,
): boolean {
  switch (check.type) {
    case "exitCode":
      return exitCode === (check.code ?? 0);
    case "outputContains":
      return output.includes(check.text);
    case "fileExists":
      return isFile(join(sandboxDir, check.path));
    case "fileNotExists":
      return !existsSync(join(sandboxDir, check.path));
    case "dirExists":
      return isDir(join(sandboxDir, check.path));
    case "fileContent": {
      const abs = join(sandboxDir, check.path);
      if (!isFile(abs)) return false;
      const content = readFileSync(abs, "utf-8");
      if (check.contains !== undefined) return content.includes(check.contains);
      if (check.equals !== undefined) return content === check.equals;
      return false;
    }
    case "fileRegex": {
      const abs = join(sandboxDir, check.path);
      if (!isFile(abs)) return false;
      return new RegExp(check.pattern).test(readFileSync(abs, "utf-8"));
    }
    default:
      return false;
  }
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function describe(check: CertCheck): string {
  switch (check.type) {
    case "exitCode":
      return `expected exit code ${check.code ?? 0}`;
    case "outputContains":
      return `output missing "${check.text}"`;
    case "fileExists":
      return `file missing: ${check.path}`;
    case "fileNotExists":
      return `file unexpectedly exists: ${check.path}`;
    case "dirExists":
      return `directory missing: ${check.path}`;
    case "fileContent": {
      const what =
        check.contains !== undefined
          ? `contains "${check.contains}"`
          : `equals "${check.equals}"`;
      return `${check.path} does not ${what}`;
    }
    case "fileRegex":
      return `${check.path} does not match ${check.pattern}`;
    default:
      return "unknown check";
  }
}
