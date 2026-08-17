import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { t } from "../../i18n/index";

export interface ProjectProfile {
  name?: string;
  runtime: string;
  deps: string[];
  devDeps: string[];
  scripts: Record<string, string>;
}

const MANIFEST_ORDER = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "requirements.txt",
];

const MAX_DEPS = 5;
const MAX_DEV_DEPS = 3;
const MAX_SCRIPTS = 3;

/**
 * Find the first existing manifest in priority order (best-effort, root only).
 */
export function detectManifest(baseDir: string): string | null {
  for (const manifest of MANIFEST_ORDER) {
    if (existsSync(join(baseDir, manifest))) return manifest;
  }
  return null;
}

/** Strip version specifiers from a manifest dependency entry. */
function cleanDependency(entry: string): string {
  let name = entry.trim();
  const eq = name.indexOf("=");
  if (eq > 0) name = name.slice(0, eq);
  const ineq = name.search(/[<>=!~^]/);
  if (ineq > 0) name = name.slice(0, ineq);
  return name.replace(/["',]/g, "").trim();
}

function readPackageJson(baseDir: string): ProjectProfile | null {
  try {
    const raw = JSON.parse(readFileSync(join(baseDir, "package.json"), "utf-8"));
    if (!raw || typeof raw !== "object") return null;
    const profile: ProjectProfile = {
      runtime: "node",
      deps: Object.keys(raw.dependencies || {}),
      devDeps: Object.keys(raw.devDependencies || {}),
      scripts: {},
    };
    if (typeof raw.name === "string" && raw.name) profile.name = raw.name;
    if (raw.scripts && typeof raw.scripts === "object") {
      for (const [key, val] of Object.entries(raw.scripts)) {
        if (typeof val === "string" && val) profile.scripts[key] = val;
      }
    }
    return profile;
  } catch {
    return null;
  }
}

function readPyproject(baseDir: string): ProjectProfile | null {
  try {
    const content = readFileSync(join(baseDir, "pyproject.toml"), "utf-8");
    const profile: ProjectProfile = { runtime: "python", deps: [], devDeps: [], scripts: {} };
    const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (nameMatch) profile.name = nameMatch[1];
    const depsBlock = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
    if (depsBlock) {
      profile.deps = [...depsBlock[1].matchAll(/"([^"]+)"/g)]
        .map((m) => cleanDependency(m[1]))
        .filter(Boolean);
    }
    return profile;
  } catch {
    return null;
  }
}

function readCargo(baseDir: string): ProjectProfile | null {
  try {
    const content = readFileSync(join(baseDir, "Cargo.toml"), "utf-8");
    const profile: ProjectProfile = { runtime: "rust", deps: [], devDeps: [], scripts: {} };
    const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (nameMatch) profile.name = nameMatch[1];
    let inDeps = false;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (/^\[.*\]$/.test(trimmed)) {
        inDeps = trimmed === "[dependencies]";
        continue;
      }
      if (inDeps && /^[A-Za-z0-9_-]+\s*=/.test(trimmed)) {
        profile.deps.push(trimmed.split("=")[0].trim());
      }
    }
    return profile;
  } catch {
    return null;
  }
}

function readGoMod(baseDir: string): ProjectProfile | null {
  try {
    const content = readFileSync(join(baseDir, "go.mod"), "utf-8");
    const profile: ProjectProfile = { runtime: "go", deps: [], devDeps: [], scripts: {} };
    const moduleMatch = content.match(/^module\s+(\S+)/m);
    if (moduleMatch) profile.name = moduleMatch[1];
    for (const line of content.split("\n")) {
      const m = line.match(/^\s*(\S+)\s+v[\d.]+/);
      if (m && !line.startsWith("//")) profile.deps.push(m[1]);
    }
    return profile;
  } catch {
    return null;
  }
}

function readRequirements(baseDir: string): ProjectProfile | null {
  try {
    const content = readFileSync(join(baseDir, "requirements.txt"), "utf-8");
    const profile: ProjectProfile = { runtime: "python", deps: [], devDeps: [], scripts: {} };
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
      profile.deps.push(cleanDependency(trimmed));
    }
    return profile;
  } catch {
    return null;
  }
}

/**
 * Read a compact project profile from the workspace manifest (best-effort).
 * Returns null when no readable manifest is present.
 */
export function readProjectProfile(baseDir: string): ProjectProfile | null {
  const manifest = detectManifest(baseDir);
  if (!manifest) return null;
  switch (manifest) {
    case "package.json":
      return readPackageJson(baseDir);
    case "pyproject.toml":
      return readPyproject(baseDir);
    case "Cargo.toml":
      return readCargo(baseDir);
    case "go.mod":
      return readGoMod(baseDir);
    case "requirements.txt":
      return readRequirements(baseDir);
    default:
      return null;
  }
}

/** One-line stack-neutral summary of the project profile. */
export function formatProjectProfile(profile: ProjectProfile): string {
  const parts: string[] = [];
  if (profile.deps.length > 0) {
    parts.push(`${t("indexer.stack_deps")}: ${profile.deps.slice(0, MAX_DEPS).join(", ")}`);
  }
  if (profile.devDeps.length > 0) {
    parts.push(`${t("indexer.stack_dev")}: ${profile.devDeps.slice(0, MAX_DEV_DEPS).join(", ")}`);
  }
  const scripts = Object.entries(profile.scripts).slice(0, MAX_SCRIPTS);
  if (scripts.length > 0) {
    parts.push(`${t("indexer.stack_scripts")}: ${scripts.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  const name = profile.name ? ` ${profile.name}` : "";
  return `[Stack: ${profile.runtime}${name} — ${parts.join(" | ")}]`;
}

/**
 * Convenience: detect + read + format in one call. Returns null when the
 * workspace has no readable manifest.
 */
export function buildProjectProfileLine(baseDir: string): string | null {
  const profile = readProjectProfile(baseDir);
  return profile ? formatProjectProfile(profile) : null;
}
