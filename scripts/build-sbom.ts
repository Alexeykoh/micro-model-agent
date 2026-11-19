/**
 * SBOM (MCP/plugin supply-chain MVP): список зависимостей с версиями
 * и лицензией из node_modules (установленные версии, не package.json- ranges).
 * Пишет `sbom.json` в корне (gitignored, артефакт релиза).
 * Svag закончить позже: добавить tarball sha256 артефактов релиза.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const nm = join(root, "node_modules");

interface SbomComponent {
  name: string;
  version: string;
  license?: string;
  dev: boolean;
}

function readPkg(path: string): { version?: string; license?: string } | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function listDepNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    // scoped packages (@scope/name)
    if (entry.name.startsWith("@")) {
      for (const sub of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
        if (sub.isDirectory()) names.push(`${entry.name}/${sub.name}`);
      }
    } else {
      names.push(entry.name);
    }
  }
  return names;
}

// dev-зависимости помечаем, чтобы SBOM различал прод/dev поверхность.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const devNames = new Set(Object.keys(pkg.devDependencies ?? {}));

const components: SbomComponent[] = listDepNames(nm)
  .map((name) => {
    const meta = readPkg(join(nm, name, "package.json"));
    if (!meta?.version) return null;
    return {
      name,
      version: meta.version,
      license: typeof meta.license === "string" ? meta.license : undefined,
      dev: devNames.has(name),
    };
  })
  .filter((c): c is SbomComponent => c !== null)
  .sort((a, b) => a.name.localeCompare(b.name));

const sbom = {
  sbomFormat: "CycloneDX-1.6",
  specVersion: "1.6",
  version: pkg.version,
  name: "micro-models-agent",
  generatedAt: new Date().toISOString(),
  components,
};

writeFileSync(join(root, "sbom.json"), `${JSON.stringify(sbom, null, 2)}\n`);
process.stdout.write(
  `[sbom] ${components.length} packages (${components.filter((c) => c.dev).length} dev) -> sbom.json\n`,
);
